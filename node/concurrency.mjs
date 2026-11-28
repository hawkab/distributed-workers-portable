import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {processLimits,processBudget} from './processes.mjs';
import {collectProfile} from './hardware.mjs';
// Admission estimates are reservations, never execution deadlines or allocation caps.
export function budget({cores,available,total,cpu,active=0,mode='shared',memoryPerJob=128*1024*1024,cpuPerJob=1,previous=1}) {
 const target=mode==='batch'?.8:mode==='router'?.25:.5,reserveFraction=mode==='batch'?.15:.25;
 if(available>=0&&total>0&&available<=Math.ceil(total*reserveFraction))return {slots:0,mode,cpu_utilization:cpu,memory_reserve_bytes:Math.ceil(total*reserveFraction)};
 if(!(cores>0)||!(available>=0)||!(total>0)||cpu===null||!Number.isFinite(cpu))return {slots:Math.min(1,previous),mode,cpu_utilization:null,memory_reserve_bytes:0};
 const reserve=Math.ceil(total*reserveFraction);
 if(available<=reserve)return {slots:0,mode,cpu_utilization:cpu,memory_reserve_bytes:reserve};
 const memory=Math.min(active+Math.floor((available-reserve)/memoryPerJob),Math.floor((total-reserve)/memoryPerJob));
 const physical=Math.max(1,Math.floor(cores/cpuPerJob));
 let slots=active+Math.floor((target-cpu)*cores/cpuPerJob);
 if(cpu>target)slots=active-Math.ceil((cpu-target)*cores/cpuPerJob);
 if(active===0&&cpu<target)slots=Math.max(1,slots);
 slots=Math.max(0,Math.min(memory,physical,slots));
 // Grow one execution at a time so the next sample includes its resource cost.
 slots=Math.min(slots,previous+1);
 return {slots,mode,cpu_utilization:cpu,memory_reserve_bytes:reserve};
}
export class Admission {
 constructor(config,directory){const c=config.concurrency??{};if(c.memory_per_job_bytes!==undefined&&!(c.memory_per_job_bytes>0)||c.cpu_per_job_cores!==undefined&&!(c.cpu_per_job_cores>0)||c.processes_per_job!==undefined&&!(Number.isSafeInteger(c.processes_per_job)&&c.processes_per_job>=1))throw Error('invalid_concurrency_reservation');this.config=config;this.directory=directory;this.previous=1;this.last=null;this.execution={max_concurrent_jobs:1,mode:config.concurrency?.mode??'shared'};}
 sample(active){
  const cpus=os.cpus();const now=process.hrtime.bigint();const sum=cpus.reduce((r,c)=>{r.idle+=c.times.idle;r.total+=Object.values(c.times).reduce((a,b)=>a+b,0);return r;},{idle:0,total:0});let cpu=null;
  if(this.last&&sum.total>this.last.total)cpu=Math.max(0,Math.min(1,1-(sum.idle-this.last.idle)/(sum.total-this.last.total)));
  // Container quotas are smaller than host /proc CPU totals. Include visible cgroup usage.
  try{const group=fs.readFileSync('/proc/self/cgroup','utf8').split('\n').find(x=>x.startsWith('0::'))?.slice(3)??'/';for(const d of new Set(['/sys/fs/cgroup',path.posix.join('/sys/fs/cgroup',group)])){let q=fs.readFileSync(d+'/cpu.max','utf8').trim().split(/\s+/);if(q[0]==='max')continue;const usage=Number(fs.readFileSync(d+'/cpu.stat','utf8').match(/^usage_usec (\d+)/m)?.[1]);const prior=this.last?.groups?.[d];sum.groups??={};sum.groups[d]=usage;if(prior!==undefined&&usage>=prior&&this.last&&cpu!==null){const elapsed=Number(now-this.last.now)/1e9;cpu=Math.max(cpu,Math.min(1,(usage-prior)/1e6/elapsed/(Number(q[0])/Number(q[1]))));}}}catch{}
  this.last={...sum,now};const profile=this.resourceSample=collectProfile([],this.directory);const r=profile.resources;const c=this.config.concurrency??{};const b=budget({cores:r.cpu_available_cores,available:r.ram_available_bytes,total:r.ram_total_bytes,cpu,active,previous:this.previous,mode:c.mode??'shared',memoryPerJob:c.memory_per_job_bytes??128*1024*1024,cpuPerJob:c.cpu_per_job_cores??1});const perJob=c.processes_per_job??16,reserveFraction=(c.mode??'shared')==='batch'?.15:.25;
  const limits=processLimits({headroom:{needed:Math.max(0,b.slots-active)*perJob,reserveFraction}});
  b.slots=processBudget(b.slots,active,limits,{perJob,reserveFraction});this.previous=b.slots;this.execution={max_concurrent_jobs:b.slots,mode:b.mode,cpu_utilization:b.cpu_utilization,memory_reserve_bytes:b.memory_reserve_bytes};return this.execution;
 }
 profile(capabilities,directory){let sampled=this.resourceSample;
  if(sampled && directory!==this.directory){
   try{if(fs.statSync(directory).dev!==fs.statSync(this.directory).dev)sampled=null;}catch{sampled=null;}
  }
  return {...(sampled??collectProfile([],directory)),capabilities:[...capabilities],execution:this.execution};}
}
export function lowerPriority(){try{os.setPriority(0,os.constants.priority.PRIORITY_BELOW_NORMAL);}catch{}}
