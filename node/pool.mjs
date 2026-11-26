import fs from 'node:fs';import path from 'node:path';
import {Worker} from './worker.mjs';import {Updater} from './updater.mjs';import {Admission,lowerPriority} from './concurrency.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export async function runPool(config,{once=false,admission:providedAdmission}={}){
 lowerPriority();const admission=providedAdmission??new Admission(config,config.state_directory);admission.sample(0);const slots=new Map();let stopping=false,updating=false,installed=false;
 const pause=()=>{for(const s of slots.values())s.worker.stopAdmission?.();};const stop=()=>{stopping=true;pause();};for(const signal of ['SIGTERM','SIGINT'])process.on(signal,stop);
 const pending=w=>!!w.store.data.active||Object.keys(w.store.data.outbox??{}).length>0;
 function start(id){const directory=id===0?config.state_directory:path.join(config.state_directory,'slots',String(id));const settings={...config,state_directory:directory,slot_id:id,profileProvider:(c,d)=>admission.profile(c,d)};const w=new Worker(settings);w.store.lock();const s={worker:w,id,finished:false,inTick:false};slots.set(id,s);s.promise=(async()=>{try{for(;;){if(stopping||installed)break;const allowed=!stopping&&!updating&&id<admission.execution.max_concurrent_jobs;if(!allowed&&!pending(w)){w.stopAdmission?.();if(once)break;await sleep(250);continue;}w.accepting=allowed||pending(w);try{s.inTick=true;try{await w.tick();}finally{s.inTick=false;}if(once)break;}catch(e){if(!stopping)console.error(JSON.stringify({event:'worker_pending',slot:id,code:e.status?'gateway_'+e.status:'transport_or_task_pending'}));if(stopping)break;if(once){process.exitCode=1;break;}await sleep(1000);}}}finally{if(stopping&&Object.keys(w.store.data.outbox??{}).length){try{await w.client.flush(w.store);}catch{console.error(JSON.stringify({event:'worker_pending',slot:id,code:'completion_retained_for_restart'}));}}w.store.unlock?.();s.finished=true;}})();return s;}
 const root=start(0);const updater=new Updater(config,root.worker.store);let nextUpdate=(root.worker.store.data.update_check_at??0)+(config.update_poll_seconds??900)*1000;
 try{
  if(once){await root.promise;return;}
  // Recover previously admitted slots even if current pressure has lowered the budget.
  const dir=path.join(config.state_directory,'slots');if(fs.existsSync(dir))for(const name of fs.readdirSync(dir)){if(!/^[1-9]\d*$/.test(name))continue;const state=path.join(dir,name,'state.json');try{const saved=JSON.parse(fs.readFileSync(state,'utf8'));if(saved.active||Object.keys(saved.outbox??{}).length)start(Number(name));}catch(e){if(e.code!=='ENOENT')throw e;}}
  while(!stopping&&!installed){
   const active=[...slots.values()].filter(s=>s.worker.executing||s.worker.store.data.active).length;admission.sample(active);
   if(Date.now()>=nextUpdate)updating=true;
   for(const s of slots.values()){if(updating||s.id>=admission.execution.max_concurrent_jobs)s.worker.stopAdmission?.();else s.worker.accepting=true;}
   if(updating&&[...slots.values()].every(s=>!s.inTick&&!pending(s.worker)&&!s.worker.executing&&!s.worker.claimController)){
    root.worker.store.data.update_check_at=Date.now();root.worker.store.save();const result=await updater.check();installed=!stopping&&result.state==='installed';updating=false;nextUpdate=Date.now()+(config.update_poll_seconds??900)*1000;if(installed){process.exitCode=75;pause();break;}
   }
   if(!updating)for(let id=0;id<admission.execution.max_concurrent_jobs;id++)if(!slots.has(id))start(id);
   await sleep(2000);
  }
 }finally{stopping=true;pause();await Promise.all([...slots.values()].map(s=>s.promise));for(const signal of ['SIGTERM','SIGINT'])process.removeListener(signal,stop);}
}
