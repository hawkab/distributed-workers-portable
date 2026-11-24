import fs from 'node:fs';
import {builtin} from './builtins.mjs';
import {Store} from './store.mjs';
import {Client} from './client.mjs';
import {Transfer} from './transfer.mjs';
import {normalizeRequest,enforceNetwork} from './request.mjs';
import {javascript} from './javascript.mjs';
import {collectProfile} from './hardware.mjs';
import {prepareCompletion} from './completion.mjs';
import {Commands} from './command.mjs';
export class Worker {
 constructor(config,{store=new Store(config.state_directory),client=new Client(config)}={}) {
  this.accepting=true;this.config=config;this.version=JSON.parse(fs.readFileSync(new URL('../VERSION.json',import.meta.url),'utf8'));
  this.store=store;this.client=client;this.transfer=new Transfer(client,store,config);this.commands=new Commands(config,client,store);
  this.capabilities=['sha256','text.normalize','http.request','artifact.stream'];
  if(config.trusted_javascript===true)this.capabilities.push('javascript','javascript.portable.v1');
  this.baseCapabilities=[...this.capabilities];
 }
 stopAdmission(){this.accepting=false;this.claimController?.abort();}
 async tick() {
  if(!this.accepting)return false;
  await this.transfer.proxyPool.refresh();this.capabilities=[...new Set([...this.baseCapabilities,...this.commands.capabilities(),...this.transfer.proxyPool.capabilities()])];
  const profile=()=>this.client.setProfile(collectProfile(this.capabilities,this.store.directory));
  profile();if(!this.client.connected)await this.client.connect(this.store);
  await this.client.flush(this.store);
  profile();await this.client.request('POST','/v1/workers/heartbeat',{json:{worker_id:this.client.workerId,version_code:this.version.code,version_name:this.version.name,capabilities:this.capabilities,abis:[process.arch],state:'idle'}});
  if(!this.accepting)return false;
  profile();this.claimController=new AbortController();const claimed=await this.client.request('POST','/v1/jobs/claim',{json:{worker_id:this.client.workerId,capabilities:this.capabilities},headers:this.config.claim_wait_seconds?{Prefer:'wait='+this.config.claim_wait_seconds}:{},signal:this.claimController.signal});this.claimController=undefined;
  if(!claimed){if(this.store.data.active){delete this.store.data.active;this.store.save();}return false;}
  await this.execute(claimed.job);await this.client.flush(this.store);return true;
 }
 async execute(job) {
  const controller=new AbortController();let lease=Date.parse(job.lease_until),progress={},renewing=false;
  const artifacts=new Map(Object.entries(this.store.data.job_artifacts[job.id]??{}));
  if(!Number.isFinite(lease))throw Error('invalid_lease');this.store.data.active={job};this.store.save();
  const remember=ref=>{artifacts.set(ref.artifact_id,ref);this.store.rememberArtifact(job,ref);};
  const renew=async()=>{
   if(renewing||controller.signal.aborted)return;renewing=true;
   try{const receipt=await this.client.request('POST','/v1/jobs/'+job.id+'/heartbeat',{json:{...this.client.identity(job),progress},signal:controller.signal});if(receipt.cancel_requested)controller.abort(Error('cancelled'));else lease=Date.parse(receipt.lease_until);}
   catch(e){if([401,403,409].includes(e.status))controller.abort(Error('lease_lost'));}finally{renewing=false;}
  };
  const timer=setInterval(()=>{if(Date.now()>=lease)controller.abort(Error('lease_expired'));else void renew();},Math.max(100,Math.min(this.config.heartbeat_ms??10000,Math.max(100,(lease-Date.now())/3))));
  const host=async(method,args)=>{
   if(controller.signal.aborted)throw controller.signal.reason;
   switch(method){
    case'progress':progress=args??{};return null;
    case'checkpoint':this.store.data.checkpoints[job.id]=args;this.store.save();return null;
    case'cancelled':return controller.signal.aborted;
    case'http.request':
     enforceNetwork(normalizeRequest(args),this.config.network,job.network);
     try{const r=await this.transfer.execute(job,args,{signal:controller.signal,progress:p=>{progress=p;}});if(r.artifact)remember(r.artifact);return r;}
     catch(e){if(e.artifact)remember(e.artifact);throw e;}
    default:throw Error('unsupported_host_operation');
   }
  };
  try {
   let status='succeeded',result=null,error;
   try {
    if(Date.now()>=lease)throw Error('lease_expired');
    switch(job.operation){
     case'sha256':case'text.normalize':result=builtin(job.operation,job.input);break;
     case'http.request':result=await host('http.request',job.input);break;
     case'command.run':result=await this.commands.execute(job,{signal:controller.signal,progress:p=>{progress=p;}});if(result.artifact)remember(result.artifact);break;
    case'javascript':if(!this.config.trusted_javascript)throw Error('javascript_disabled');result=await javascript(job,this.store.data.checkpoints[job.id]??null,host,{signal:controller.signal});break;
     default:throw Error('unsupported_operation');
    }
   } catch(e) {
    if(!controller.signal.aborted&&(['PROXY_PENDING','ECONNRESET','ECONNREFUSED','EAI_AGAIN','ENOTFOUND','EPIPE','ETIMEDOUT'].includes(e.code)||e.status>=500||e.status===429))throw e;
    status='failed';error={code:controller.signal.aborted?(controller.signal.reason?.message??'cancelled'):(e.message??'execution_failed'),message:'Task execution did not complete'};
    result=e.responseResult??(e.artifact?{artifact:e.artifact}:null);if(e.artifact)remember(e.artifact);
   }
   const body={...this.client.identity(job),status,result,artifact_ids:[...new Set([...artifacts.keys(),...Object.keys(this.store.data.job_artifacts[job.id]??{})])],...(error?{error}:{})};
   const completion=await prepareCompletion(this.client,this.store,job,body,{controlBytes:this.config.control_bytes??16777216,chunkBytes:this.config.chunk_bytes??262144,signal:status==='failed'?undefined:controller.signal,progress:p=>{progress=p;}});
   this.store.putCompletion(job,completion);delete this.store.data.active;this.store.save();return completion;
  } finally {clearInterval(timer);controller.abort();}
 }
}
