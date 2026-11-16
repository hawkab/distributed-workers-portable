import http from 'node:http';
import https from 'node:https';
import {armTimeout} from './timers.mjs';
export class HTTPFailure extends Error {constructor(status,body){super('http_'+status);this.status=status;this.body=body;}}
export function open(method,url,{headers={},body,signal,idleTimeoutMs=0,connectTimeoutMs=0,responseHeaderIdleMs=0}={}) {
 return new Promise((resolve,reject)=>{
  const u=new URL(url);if(!['http:','https:'].includes(u.protocol)||u.username||u.password){reject(Error('invalid_http_url'));return;}
  let stopConnect=()=>{},stopHeader=()=>{},headersReceived=false,headerSocket;
  const timeout=message=>{const e=Error(message);e.code='ETIMEDOUT';request.destroy(e);};
  const refreshHeader=()=>{stopHeader();if(!headersReceived)stopHeader=armTimeout(()=>timeout('read_idle_timeout'),responseHeaderIdleMs);};
  const request=(u.protocol==='https:'?https:http).request(u,{method,headers,signal},response=>{headersReceived=true;stopHeader();headerSocket?.removeListener('data',refreshHeader);resolve(response);});
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
 identity(job){return {worker_id:this.workerId,attempt_id:job.attempt_id,fencing_token:job.fencing_token};}
 headers(job){return {Authorization:'Bearer '+this.token,...(job?{'X-Worker-Id':this.workerId,'X-Attempt-Id':job.attempt_id,'X-Fencing-Token':String(job.fencing_token)}:{})};}
 async request(method,route,{json,body,headers={},job,signal}={}){const payload=json===undefined?body:Buffer.from(JSON.stringify(json));const response=await open(method,this.base+route,{headers:{...this.headers(job),...(json===undefined?{}:{'Content-Type':'application/json'}),...headers},body:payload,signal,idleTimeoutMs:this.controlIdleMs});const bytes=await readBounded(response,this.controlBytes);let value;try{value=bytes.length?JSON.parse(bytes.toString()):null;}catch{throw Error('invalid_gateway_json');}if(response.statusCode<200||response.statusCode>=300)throw new HTTPFailure(response.statusCode,value);return value;}
 async flush(store){for(const [attempt,item] of Object.entries(store.data.outbox)){try{const receipt=await this.request('POST','/v1/jobs/'+encodeURIComponent(item.job_id)+'/complete',{json:item.body});store.acknowledge(attempt,receipt);}catch(e){if(e.status>=400&&e.status<500&&![401,403,408,429].includes(e.status)){store.quarantine(attempt,{status:e.status,response:e.body});continue;}throw e;}}}
}
