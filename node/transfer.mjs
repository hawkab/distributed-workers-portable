import crypto from 'node:crypto';
import {ProxyPool} from './proxy.mjs';
import {open} from './client.mjs';
import {sourceRequest,sourceChunks} from './source.mjs';
export {normalizeRequest as validateRequest} from './request.mjs';
import {normalizeRequest} from './request.mjs';
export class Transfer {
 constructor(client,store,config={}){this.client=client;this.store=store;this.network=config.network;this.proxyPool=new ProxyPool(config,store);this.chunkBytes=config.chunk_bytes??256*1024;if(!Number.isSafeInteger(this.chunkBytes)||this.chunkBytes<=0)throw new Error('invalid_chunk_bytes');this.peakBufferedBytes=0;}
 async execute(job,raw,{signal,progress=()=>{},executionId=crypto.randomUUID()}={}) {
  const input=normalizeRequest(raw),key=job.attempt_id+':'+input.effect_id,identity=this.client.identity(job);
  let state=this.store.data.transfers[key];
  if(state?.upload_id&&state.response_meta&&state.execution_id){
   const prior=await this.client.request('GET','/v1/artifacts/'+state.upload_id+'/status',{job,signal});
   if(prior.status==='sealed'&&prior.artifact){state.result={...state.response_meta,artifact:prior.artifact};this.store.save();}
  }
  // Finish a durably captured actual response without contacting its vendor again.
  if(state?.result){await this.finishEffect(job,input,state,state.result,signal);return this.view(job,input,state.result,signal);}
  let proxy,completedOnly=false;try{proxy=this.proxyPool.select();}catch(error){if(error.code!=='PROXY_PENDING')throw error;let prior;try{prior=await this.client.request('GET',this.effectPath(job,input)+'/status',{job,signal});}catch(e){if(e.status!==404)throw e;}if(prior?.state!=='completed'&&!(input.replay==='never'&&['started','uncertain'].includes(prior?.state)))throw error;completedOnly=true;}

  const effect=await this.client.request('POST',this.effectPath(job,input)+'/begin',{json:{...identity,execution_id:executionId,request:input},signal});
  if(effect.state==='completed')return this.view(job,input,effect.response,signal);
  if(effect.state==='uncertain')throw new Error('external_effect_uncertain_not_replayed');
  if(completedOnly){const e=new Error('proxy_unavailable');e.code='PROXY_PENDING';throw e;}
  if(effect.state!=='execute'||!effect.request_sha256)throw new Error('invalid_effect_receipt');
  state??={generation:0};Object.assign(state,{execution_id:executionId,request_sha256:effect.request_sha256});this.store.data.transfers[key]=state;this.store.save();
  if(!state.upload_id){const created=await this.client.request('POST','/v1/jobs/'+job.id+'/artifacts',{json:{...identity,key:input.effect_id+'/'+executionId+'/'+state.generation,...(input.response.name?{name:input.response.name}:{}),media_type:input.response.media_type??'application/octet-stream'},signal});state.upload_id=created.upload_id;this.store.save();}
  const status=await this.client.request('GET','/v1/artifacts/'+state.upload_id+'/status',{job,signal});if(status.cancel_requested)throw new Error('cancelled');let offset=status.offset??0;
  if(offset>0&&!state.validator){await this.restartUpload(job,state,signal);return this.execute(job,raw,{signal,progress,executionId});}
  const headers={...input.headers};if(!Object.keys(headers).some(x=>x.toLowerCase()==='accept-encoding'))headers['Accept-Encoding']='identity';
  if(input.replay==='idempotent'&&input.idempotency_key)headers[input.idempotency_header??'Idempotency-Key']=input.idempotency_key;
  if(offset>0){headers.Range='bytes='+offset+'-';headers['If-Range']=state.validator;}
  const source=await sourceRequest(input,{headers,signal,policies:[this.network,job.network],proxyPool:this.proxyPool,proxy});
  if(offset>0){const range=/^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(String(source.headers['content-range']??''));if(source.statusCode!==206||!range||Number(range[1])!==offset||source.headers.etag!==state.validator){source.destroy();await this.restartUpload(job,state,signal);return this.execute(job,raw,{signal,progress,executionId});}}
  else{const etag=source.headers.etag;state.validator=typeof etag==='string'&&!etag.startsWith('W/')?etag:null;this.store.save();}
  const responseHeaders={};for(let i=0;i<source.rawHeaders.length;i+=2){const name=source.rawHeaders[i].toLowerCase();(responseHeaders[name]??=[]).push(source.rawHeaders[i+1]);}const responseMeta=state.response_meta??{status:source.statusCode,headers:responseHeaders,url:source.fleetUrl??input.url};state.response_meta=responseMeta;this.store.save();let buffer=Buffer.allocUnsafe(this.chunkBytes),used=0;
  const send=async()=>{if(!used)return;const receipt=await this.client.request('PUT','/v1/artifacts/'+state.upload_id+'/chunks/'+offset,{body:buffer.subarray(0,used),headers:{'Content-Type':'application/octet-stream'},job,signal});if(receipt.offset!==offset||receipt.next_offset!==offset+used)throw new Error('chunk_ack_offset_mismatch');offset=receipt.next_offset;state.offset=offset;this.store.save();progress({downloaded_bytes:offset});used=0;};
  try{for await(const chunk of sourceChunks(source,input.timeouts?.read_idle_ms??0)){let start=0;while(start<chunk.length){const n=Math.min(this.chunkBytes-used,chunk.length-start);chunk.copy(buffer,used,start,start+n);used+=n;start+=n;this.peakBufferedBytes=Math.max(this.peakBufferedBytes,used+chunk.length);if(used===this.chunkBytes)await send();}}await send();}catch(e){source.destroy();throw e;}
  const artifact=await this.client.request('POST','/v1/artifacts/'+state.upload_id+'/finish',{json:{...identity,length:offset},signal});if(!artifact.artifact_id||artifact.length!==offset||!/^[a-f0-9]{64}$/.test(artifact.sha256))throw new Error('invalid_artifact_receipt');
  const result={...responseMeta,artifact:{artifact_id:artifact.artifact_id,length:artifact.length,sha256:artifact.sha256,media_type:artifact.media_type??input.response.media_type??source.headers['content-type']??'application/octet-stream',...(input.response.name?{name:input.response.name}:{})}};
  state.result=result;this.store.save();await this.finishEffect(job,input,state,result,signal);return this.view(job,input,result,signal);
 }
 effectPath(job,input){return '/v1/jobs/'+job.id+'/effects/'+encodeURIComponent(input.effect_id);}
 async finishEffect(job,input,state,result,signal){try{const receipt=await this.client.request('POST',this.effectPath(job,input)+'/finish',{json:{...this.client.identity(job),execution_id:state.execution_id,request_sha256:state.request_sha256,response:result,artifact_ids:result.artifact?[result.artifact.artifact_id]:[]},signal});if(receipt.recorded!==true&&!receipt.candidate_saved)throw new Error('effect_finish_not_recorded');}catch(e){if(e.status>=400&&e.status<500&&![401,403,408,429].includes(e.status)){state.effect_quarantine={status:e.status,response:e.body};this.store.save();e.artifact=result.artifact;e.responseResult=result;}throw e;}}
 async restartUpload(job,state,signal){await this.client.request('POST','/v1/artifacts/'+state.upload_id+'/abort',{json:this.client.identity(job),signal});state.generation++;delete state.upload_id;delete state.validator;delete state.response_meta;this.store.save();}
 async view(job,input,result,signal){
  if(input.response.mode==='artifact')return result;
  if(result.artifact.length>input.response.max_bytes)return {...result,body_error:{code:'inline_limit_exceeded'}};
  const content=await open('GET',this.client.base+'/v1/artifacts/'+result.artifact.artifact_id+'/content',{headers:this.client.headers(job),signal});
  if(content.statusCode!==200){content.destroy();throw new Error('inline_artifact_unavailable');}
  const parts=[];let n=0;for await(const part of content){n+=part.length;if(n>input.response.max_bytes){content.destroy();return {...result,body_error:{code:'inline_limit_exceeded'}};}parts.push(part);}
  let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts,n));}catch{return {...result,body_error:{code:'invalid_utf8'}};}
  if(input.response.mode==='text')return {...result,body_text:text};
  try{return {...result,body_json:JSON.parse(text)};}catch{return {...result,body_error:{code:'invalid_json'}};}
 }
}
