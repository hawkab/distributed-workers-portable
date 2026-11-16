import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {finished} from 'node:stream/promises';
import {encodedJSON} from './completion.mjs';

function failure(code,result){const error=Error(code);if(result){error.responseResult=result;error.artifact=result.artifact;}return error;}
function transient(error){return error.status===408||error.status===425||error.status===429||error.status>=500||['ECONNRESET','ECONNREFUSED','EAI_AGAIN','ENOTFOUND','EPIPE','ETIMEDOUT'].includes(error.code);}
async function retry(operation){let delay=1000;for(;;){try{return await operation();}catch(error){if(!transient(error))throw error;await new Promise(resolve=>setTimeout(resolve,delay));delay=Math.min(30000,delay*2);}}}
function fingerprint(stat){return [stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs,stat.mode].map(String).join(':');}
export function inspectExecutable(file){const hash=crypto.createHash('sha256'),fd=fs.openSync(file,'r'),buffer=Buffer.allocUnsafe(65536);try{const before=fs.fstatSync(fd,{bigint:true});if(!before.isFile())throw Error('command_executable_not_file');for(let n;(n=fs.readSync(fd,buffer,0,buffer.length,null))>0;)hash.update(buffer.subarray(0,n));const after=fs.fstatSync(fd,{bigint:true});if(fingerprint(before)!==fingerprint(after))throw Error('command_executable_changed_during_check');return {sha256:hash.digest('hex'),fingerprint:fingerprint(after)};}finally{fs.closeSync(fd);}}
function emptyNetwork(policy){return policy===undefined||policy===null||Object.keys(policy).length===0;}
function validate(config){
 if(!config||typeof config!=='object'||!path.isAbsolute(config.executable??'')||!Array.isArray(config.argv??[])||(config.argv??[]).some(value=>typeof value!=='string'||value.includes('\0'))||!(/^[a-f0-9]{64}$/).test(config.sha256??'')||typeof config.capability!=='string'||!config.capability||/\s/.test(config.capability)||['command.run','command.run.v1','artifact.stream'].includes(config.capability))throw Error('invalid_command_configuration');
 if(!['safe','never'].includes(config.replay??'never')||!Number.isSafeInteger(config.stderr_bytes??16384)||(config.stderr_bytes??16384)<0)throw Error('invalid_command_configuration');
 if(config.env!==undefined&&(!config.env||typeof config.env!=='object'||Array.isArray(config.env)||Object.entries(config.env).some(([key,value])=>!(/^[A-Za-z_][A-Za-z0-9_]*$/).test(key)||typeof value!=='string'||value.includes('\0'))))throw Error('invalid_command_environment');
 return config;
}
export class Commands {
 constructor(config,client,store,{inspect=inspectExecutable}={}){this.inspect=inspect;this.verified=new Map();this.programs=config.commands??{};this.client=client;this.store=store;this.chunkBytes=config.chunk_bytes??262144;this.network=config.network;if(!Number.isSafeInteger(this.chunkBytes)||this.chunkBytes<=0)throw Error('invalid_chunk_bytes');if(!this.programs||typeof this.programs!=='object'||Array.isArray(this.programs))throw Error('invalid_command_configuration');this.usable=new Map();}
 capabilities(){
  this.usable.clear();
  if(!emptyNetwork(this.network))return [];
  for(const [id,entry] of Object.entries(this.programs)){
   try{const program=validate(entry),stat=fs.statSync(program.executable,{bigint:true});if(!id||!stat.isFile())continue;fs.accessSync(program.executable,fs.constants.X_OK);const cacheKey=program.executable+'\0'+program.sha256,cached=this.verified.get(cacheKey);if(cached?.fingerprint!==fingerprint(stat)){const inspected=this.inspect(program.executable);if(inspected.sha256!==program.sha256)continue;this.verified.set(cacheKey,inspected);}this.usable.set(id,program);}catch{/* Unusable private entries do not advertise execution. */}
  }
  return this.usable.size?['command.run.v1',...new Set([...this.usable.values()].map(program=>program.capability))]:[];
 }
 async execute(job,{signal,progress=()=>{}}={}){
  const input=job.input;if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['program','payload'].includes(key))||typeof input.program!=='string'||!input.payload||typeof input.payload!=='object'||Array.isArray(input.payload))throw Error('invalid_command_input');
  if(!emptyNetwork(job.network)||!emptyNetwork(this.network))throw Error('command_network_policy_not_enforceable');
  const program=validate(this.programs[input.program]);
  if(signal?.aborted)throw signal.reason??Error('cancelled');
  this.store.data.command_runs??={};const key=job.attempt_id,identity=this.client.identity(job);
  const fingerprint=crypto.createHash('sha256').update(JSON.stringify({program:input.program,sha256:program.sha256,argv:program.argv??[],env:program.env??{},payload:input.payload})).digest('hex');
  let state=this.store.data.command_runs[key];
  if(state&&state.fingerprint!==fingerprint)throw Error('command_pending_input_changed');
  if(state?.result){if(state.result.exit_code!==0||state.result.signal||state.result.error_code)throw failure(state.result.error_code??'command_failed',state.result);return state.result;}
  if(state?.stdout_complete&&state.exit_recorded)return this.finish(job,state,program);
  fs.accessSync(program.executable,fs.constants.X_OK);if(this.inspect(program.executable).sha256!==program.sha256)throw Error('command_executable_hash_mismatch');
  if(state?.phase==='started'){
   if((program.replay??'never')!=='safe')throw Error('command_outcome_uncertain');
   state={previous_upload_id:state.upload_id,generation:(state.generation??0)+1};
  }
  state={...state,job_id:job.id,attempt_id:job.attempt_id,fingerprint,program:input.program,phase:'prepared',execution_id:crypto.randomUUID(),generation:state?.generation??0};this.store.data.command_runs[key]=state;this.store.save();
  if(!state.upload_id){const created=await retry(()=>this.client.request('POST','/v1/jobs/'+encodeURIComponent(job.id)+'/artifacts',{json:{...identity,key:'command/'+key+'/'+state.execution_id,name:program.name??'stdout.bin',media_type:program.media_type??'application/octet-stream'}}));state.upload_id=created.upload_id;this.store.save();}
  if(signal?.aborted)throw signal.reason??Error('cancelled');
  state.phase='started';this.store.save();
  const env={...(process.platform==='win32'&&process.env.SystemRoot?{SystemRoot:process.env.SystemRoot}:{}),...(program.env??{})};
  const child=spawn(program.executable,program.argv??[],{shell:false,env,cwd:os.tmpdir(),stdio:['pipe','pipe','pipe'],windowsHide:true,detached:process.platform!=='win32'});
  let killed=false,spawnError=null,stdinFailure=null,tail=Buffer.alloc(0),stderrBytes=0;const stderrBudget=program.stderr_bytes??16384;
  const kill=()=>{
   if(killed)return;killed=true;
   if(process.platform==='win32'&&child.pid){const system=process.env.SystemRoot;if(system){const killer=spawn(path.join(system,'System32','taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{shell:false,env:{SystemRoot:system},stdio:'ignore',windowsHide:true});killer.on('error',()=>child.kill('SIGKILL'));}else child.kill('SIGKILL');}
   else if(child.pid){try{process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}}
  };
  const abort=()=>kill();signal?.addEventListener('abort',abort,{once:true});
  const onExit=()=>kill();process.once('exit',onExit);if(signal?.aborted)kill();
  const closed=new Promise(resolve=>{child.on('error',error=>{spawnError=error;});child.once('close',(code,terminated)=>resolve({code,terminated}));});
  const stderr=(async()=>{for await(const bytes of child.stderr){stderrBytes+=bytes.length;if(stderrBudget){tail=bytes.length>=stderrBudget?Buffer.from(bytes.subarray(bytes.length-stderrBudget)):Buffer.concat([tail,bytes]).subarray(Math.max(0,tail.length+bytes.length-stderrBudget));}}})();
  child.stdin.on('error',error=>{stdinFailure=error;});
  const stdin=(async()=>{try{for(const bytes of encodedJSON(input.payload)){if(!child.stdin.write(bytes))await once(child.stdin,'drain');}child.stdin.end();await finished(child.stdin);}catch(error){stdinFailure=error;if(!['EPIPE','ERR_STREAM_DESTROYED','ERR_STREAM_WRITE_AFTER_END','ABORT_ERR'].includes(error.code))throw error;}})();
  let outcome;
  try{
   const output=this.capture(job,state,child.stdout,progress).catch(error=>{kill();throw error;});
   const results=await Promise.allSettled([output,closed,stderr,stdin]);outcome=results[1].value;
   state.exit_recorded=true;state.exit_code=outcome.code;state.signal=outcome.terminated;state.stderr={tail_base64:tail.toString('base64'),bytes:stderrBytes,retained_bytes:tail.length,truncated:stderrBytes>tail.length};
   if(stdinFailure)state.error_code='command_stdin_failed';if(spawnError)state.error_code='command_spawn_failed';if(signal?.aborted)state.error_code=signal.reason?.message??'cancelled';this.store.save();
   for(const result of results)if(result.status==='rejected')throw result.reason;
   return await this.finish(job,state,program);
  }finally{signal?.removeEventListener('abort',abort);process.removeListener('exit',onExit);if(!outcome)kill();}
 }
 async capture(job,state,stream,progress){
  const digest=crypto.createHash('sha256');let offset=0,used=0;const buffer=Buffer.allocUnsafe(this.chunkBytes);
  const send=async()=>{if(!used)return;const bytes=buffer.subarray(0,used),start=offset;const ack=await retry(()=>this.client.request('PUT','/v1/artifacts/'+encodeURIComponent(state.upload_id)+'/chunks/'+start,{body:bytes,headers:{'Content-Type':'application/octet-stream'},job}));if(ack.offset!==start||ack.next_offset!==start+used)throw Error('command_chunk_ack_mismatch');digest.update(bytes);offset+=used;state.offset=offset;this.store.save();progress({phase:'command_stdout',bytes:offset});used=0;};
  for await(const bytes of stream){let start=0;while(start<bytes.length){const count=Math.min(this.chunkBytes-used,bytes.length-start);bytes.copy(buffer,used,start,start+count);used+=count;start+=count;if(used===this.chunkBytes)await send();}}
  await send();state.stdout_complete=true;state.length=offset;state.sha256=digest.digest('hex');this.store.save();
 }
 async finish(job,state,program){
  const artifact=await retry(()=>this.client.request('POST','/v1/artifacts/'+encodeURIComponent(state.upload_id)+'/finish',{json:{...this.client.identity(job),length:state.length,sha256:state.sha256}}));
  if(artifact.length!==state.length||artifact.sha256!==state.sha256||typeof artifact.artifact_id!=='string')throw Error('command_artifact_integrity_mismatch');
  const result={artifact,exit_code:state.exit_code,stderr:state.stderr??{tail_base64:'',bytes:0,retained_bytes:0,truncated:false},...(state.signal?{signal:state.signal}:{}),...(state.error_code?{error_code:state.error_code}:{})};state.result=result;state.phase='finished';this.store.rememberArtifact(job,artifact);this.store.save();
  if(result.exit_code!==0||result.signal||result.error_code)throw failure(result.error_code??'command_exit_nonzero',result);return result;
 }
}
