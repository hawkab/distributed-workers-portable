import crypto from 'node:crypto';

const immediate=()=>new Promise(resolve=>setImmediate(resolve));
function* stringTokens(text){yield '"';let part='';for(let i=0;i<text.length;i++){const code=text.charCodeAt(i);let value;if(code===34)value='\\"';else if(code===92)value='\\\\';else if(code<32)value=({8:'\\b',9:'\\t',10:'\\n',12:'\\f',13:'\\r'})[code]??'\\u'+code.toString(16).padStart(4,'0');else if(code>=0xd800&&code<=0xdbff){const next=text.charCodeAt(i+1);if(next>=0xdc00&&next<=0xdfff)value=text[i]+text[++i];else value='\\u'+code.toString(16).padStart(4,'0');}else if(code>=0xdc00&&code<=0xdfff)value='\\u'+code.toString(16).padStart(4,'0');else value=text[i];part+=value;if(part.length>=8192){yield part;part='';}}if(part)yield part;yield '"';}
function* tokens(value,seen=new Set()){
 if(value===null){yield 'null';return;}if(typeof value==='string'){yield*stringTokens(value);return;}if(typeof value==='number'){yield Number.isFinite(value)?String(value):'null';return;}if(typeof value==='boolean'){yield value?'true':'false';return;}
 if(typeof value!=='object')throw new Error('completion_result_not_json');if(seen.has(value))throw new Error('completion_result_cycle');seen.add(value);
 try{if(Array.isArray(value)){yield '[';for(let i=0;i<value.length;i++){if(i)yield ',';yield*tokens(value[i]===undefined?null:value[i],seen);}yield ']';}else{yield '{';let first=true;for(const key of Object.keys(value)){if(value[key]===undefined)continue;if(!first)yield ',';first=false;yield*stringTokens(key);yield ':';yield*tokens(value[key],seen);}yield '}';}}finally{seen.delete(value);}
}
export function* encodedJSON(value){for(const token of tokens(value))yield Buffer.from(token,'utf8');}
function fits(value,budget){let size=0;for(const bytes of encodedJSON(value)){size+=bytes.length;if(size>budget)return false;}return true;}
function addArtifact(completion,artifact){return {...completion,artifact_ids:[...new Set([...(completion.artifact_ids??[]),artifact.artifact_id])]};}
function httpArtifact(result){return result&&typeof result==='object'&&Number.isInteger(result.status)&&typeof result.url==='string'&&result.headers&&typeof result.headers==='object'&&typeof result.artifact?.artifact_id==='string';}
function check(signal){if(signal?.aborted)throw signal.reason??new Error('cancelled');}

export async function prepareCompletion(client,store,job,completion,{controlBytes=16777216,chunkBytes=262144,signal,progress=()=>{}}={}){
 if(!Number.isSafeInteger(controlBytes)||controlBytes<0||!Number.isSafeInteger(chunkBytes)||chunkBytes<=0)throw new Error('invalid_completion_budget');
 if(fits(completion,controlBytes))return completion;
 const result=completion.result;
 if(httpArtifact(result)){
  const stripped={...result,body_error:{code:'control_budget_exceeded'}};delete stripped.body_text;delete stripped.body_json;
  const candidate=addArtifact({...completion,result:stripped},result.artifact);
  if(fits(candidate,controlBytes))return candidate;
 }
 // The result already exists in memory; serialize incrementally without a second
 // body-wide Buffer/string or a local binary staging file.
 let length=0;const digest=crypto.createHash('sha256');
 for(const bytes of encodedJSON(result)){check(signal);length+=bytes.length;digest.update(bytes);await immediate();}
 const hash=digest.digest('hex'),key='completion/'+job.attempt_id+'/'+hash;
 store.data.completion_transfers??={};let state=store.data.completion_transfers[key];
 if(!state){state={key,job_id:job.id,attempt_id:job.attempt_id,length,sha256:hash};store.data.completion_transfers[key]=state;store.save();}
 const identity=client.identity(job),base='/v1/artifacts/';
 if(!state.upload_id){const created=await client.request('POST','/v1/jobs/'+encodeURIComponent(job.id)+'/artifacts',{json:{...identity,key,name:'result.json',media_type:'application/json'},signal});state.upload_id=created.upload_id;store.save();}
 const path=base+encodeURIComponent(state.upload_id);
 const status=await client.request('GET',path+'/status',{job,signal});if(status.cancel_requested)throw new Error('cancelled');
 let artifact=status.artifact??state.artifact,offset=status.offset??0;
 if(!Number.isSafeInteger(offset)||offset<0||offset>length)throw new Error('completion_upload_offset_invalid');
 if(!artifact){
  let position=0,used=0,buffer=Buffer.allocUnsafe(chunkBytes);
  const send=async()=>{if(!used)return;check(signal);await progress({phase:'completion_streaming',bytes:offset});const receipt=await client.request('PUT',path+'/chunks/'+offset,{body:buffer.subarray(0,used),headers:{'Content-Type':'application/octet-stream'},job,signal});if(receipt.offset!==offset||receipt.next_offset!==offset+used)throw new Error('completion_chunk_ack_mismatch');offset=receipt.next_offset;state.offset=offset;store.save();used=0;};
  const skip=offset;
  for(const bytes of encodedJSON(result)){check(signal);let begin=Math.max(0,skip-position);position+=bytes.length;if(begin>=bytes.length)continue;while(begin<bytes.length){const n=Math.min(chunkBytes-used,bytes.length-begin);bytes.copy(buffer,used,begin,begin+n);used+=n;begin+=n;if(used===chunkBytes)await send();}await immediate();}
  await send();artifact=await client.request('POST',path+'/finish',{json:{...identity,length,sha256:hash},signal});state.artifact=artifact;store.save();
 }
 if(artifact.length!==length||artifact.sha256!==hash||typeof artifact.artifact_id!=='string')throw new Error('completion_artifact_integrity_mismatch');
 const replacement={artifact,result_format:'json',body_error:{code:'control_budget_exceeded'}};
 const candidate=addArtifact({...completion,result:replacement},artifact);
 if(!fits(candidate,controlBytes))throw new Error('completion_metadata_exceeds_control_budget');
 return candidate;
}
