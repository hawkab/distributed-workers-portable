import http from 'node:http';
import https from 'node:https';
import {armTimeout} from './timers.mjs';
import {encodeProfile} from './hardware.mjs';
const directHTTP=new http.Agent({keepAlive:true,proxyEnv:{}}),directHTTPS=new https.Agent({keepAlive:true,proxyEnv:{}});
export class HTTPFailure extends Error {constructor(status,body){super('http_'+status);this.status=status;this.body=body;}}
export function open(method,url,{headers={},body,signal,idleTimeoutMs=0,connectTimeoutMs=0,responseHeaderIdleMs=0,agent,requestOptions={}}={}) {
 return new Promise((resolve,reject)=>{
  const u=new URL(url);if(!['http:','https:'].includes(u.protocol)||u.username||u.password){reject(Error('invalid_http_url'));return;}
  let stopConnect=()=>{},stopHeader=()=>{},headersReceived=false,headerSocket;
  const timeout=message=>{const e=Error(message);e.code='ETIMEDOUT';request.destroy(e);};
  const refreshHeader=()=>{stopHeader();if(!headersReceived)stopHeader=armTimeout(()=>timeout('read_idle_timeout'),responseHeaderIdleMs);};
  const request=(u.protocol==='https:'?https:http).request(u,{method,headers,signal,agent:agent??(u.protocol==='https:'?directHTTPS:directHTTP),...requestOptions},response=>{headersReceived=true;stopHeader();headerSocket?.removeListener('data',refreshHeader);resolve(response);});
  if(connectTimeoutMs>0){stopConnect=armTimeout(()=>timeout('connect_timeout'),connectTimeoutMs);request.on('socket',socket=>{if(!socket.connecting)stopConnect();else socket.once(u.protocol==='https:'?'secureConnect':'connect',()=>stopConnect());});}
  request.setTimeout(idleTimeoutMs,()=>timeout('http_idle_timeout'));
  request.once('finish',()=>{if(responseHeaderIdleMs>0&&!headersReceived){headerSocket=request.socket;headerSocket?.on('data',refreshHeader);refreshHeader();}});
  request.on('close',()=>{stopConnect();stopHeader();headerSocket?.removeListener('data',refreshHeader);});request.on('error',reject);
  if(body===undefined||body===null)request.end();else if(typeof body.pipe==='function'){body.on('error',e=>request.destroy(e));body.pipe(request);}else request.end(body);
 });
}
export async function readBounded(response,maxBytes){const chunks=[];let n=0;for await(const chunk of response){n+=chunk.length;if(n>maxBytes){response.destroy();throw Error('control_response_exceeds_budget');}chunks.push(chunk);}return Buffer.concat(chunks,n);}
export class Client {
 constructor(config){this.base=config.gateway.replace(/\/+$/,'');this.workerId=config.worker_id;this.token=config.token;this.controlBytes=config.control_bytes??16*1024*1024;this.controlIdleMs=config.control_idle_ms??30000;}
 setProfile(profile){this.profile=encodeProfile(profile);}
 async connect(store,{signal}={}){
  const persisted=store.data.worker_identity?.worker_id;const pendingIds=[...new Set(Object.values(store.data.outbox??{}).map(v=>v.body?.worker_id).filter(v=>typeof v==='string'&&v))];
  const previous=persisted??this.workerId??(pendingIds.length===1?pendingIds[0]:undefined);
  const pending=Object.keys(store.data.outbox??{}).length>0||!!store.data.active||['transfers','checkpoints','job_artifacts','completion_transfers','command_runs'].some(k=>Object.keys(store.data[k]??{}).length>0);
  if(pending&&(!previous||pendingIds.some(id=>id!==previous)))throw Error('pending_worker_identity_unknown_or_conflicting');
  if(previous)this.workerId=previous;
  const receipt=await this.request('POST','/v1/workers/connect',{json:{},signal});
  if(!receipt||typeof receipt.worker_id!=='string'||!receipt.worker_id)throw Error('invalid_connect_receipt');
  if(previous&&receipt.worker_id!==previous&&pending)throw Error('worker_identity_changed_with_pending_work');
  const identity={worker_id:receipt.worker_id};store.data.worker_identity=identity;store.save();this.workerId=identity.worker_id;this.connected=true;
  return receipt;
 }
 identity(job){return {worker_id:this.workerId,attempt_id:job.attempt_id,fencing_token:job.fencing_token};}
 headers(job){return {Authorization:'Bearer '+this.token,...(job?{'X-Worker-Id':this.workerId,'X-Attempt-Id':job.attempt_id,'X-Fencing-Token':String(job.fencing_token)}:{})};}
 async request(method,route,{json,body,headers={},job,signal}={}){const payload=json===undefined?body:Buffer.from(JSON.stringify(json));const response=await open(method,this.base+route,{headers:{...this.headers(job),...(json===undefined?{}:{'Content-Type':'application/json'}),...((['/v1/workers/connect','/v1/workers/heartbeat','/v1/jobs/claim'].includes(route)&&this.profile)?{'X-Worker-Profile':this.profile}:{}),...headers},body:payload,signal,idleTimeoutMs:this.controlIdleMs});if(route==='/v1/jobs/claim')this.waitApplied=!!response.headers['preference-applied'];const bytes=await readBounded(response,this.controlBytes);let value;try{value=bytes.length?JSON.parse(bytes.toString()):null;}catch{throw Error('invalid_gateway_json');}if(response.statusCode<200||response.statusCode>=300)throw new HTTPFailure(response.statusCode,value);return value;}
 async flush(store){for(const [attempt,item] of Object.entries(store.data.outbox)){try{const receipt=await this.request('POST','/v1/jobs/'+encodeURIComponent(item.job_id)+'/complete',{json:item.body});store.acknowledge(attempt,receipt);}catch(e){if(e.status>=400&&e.status<500&&![401,403,408,429].includes(e.status)){store.quarantine(attempt,{status:e.status,response:e.body});continue;}throw e;}}}
}
