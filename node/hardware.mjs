import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import v8 from 'node:v8';
const positive=n=>typeof n==='number'&&Number.isFinite(n)&&n>0?n:null;
function hierarchy(base,relative){const all=[base];let p=path.posix.join(base,relative);while(p!==base&&p.startsWith(base+'/')){all.push(p);p=path.posix.dirname(p);}return all;}
const nonnegative=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0?n:null;
const minimum=(...values)=>{const known=values.filter(v=>v!==null);return known.length?Math.min(...known):null;};
export function cpuListCount(text){if(typeof text!=='string'||!text.trim())return null;const spans=[];for(const s of text.trim().split(',')){const m=/^(\d+)(?:-(\d+))?$/.exec(s);if(!m)return null;const a=Number(m[1]),b=Number(m[2]??m[1]);if(!Number.isSafeInteger(b)||b<a)return null;spans.push([a,b]);}spans.sort((a,b)=>a[0]-b[0]);let count=0,end=-1;for(const [a,b] of spans){count+=Math.max(0,b-Math.max(a,end+1)+1);end=Math.max(end,b);}return positive(count);}
export function collectHardware(stateDirectory,{readFile=p=>fs.readFileSync(p,'utf8'),readDir=p=>fs.readdirSync(p),statfs=p=>fs.statfsSync(p),system=os,runtime=process,heap=()=>v8.getHeapStatistics()}={}){
 const read=p=>{try{return readFile(p).trim();}catch{return null;}};
 const query=f=>{try{return f();}catch{return null;}};
 const integer=p=>{const t=read(p);return t!==null&&/^\d+$/.test(t)?nonnegative(Number(t)):null;};
 const platform=query(()=>system.platform())??null,architecture=query(()=>system.arch())??null;
 const logical=positive(query(()=>system.cpus().length)),parallel=positive(query(()=>system.availableParallelism()));
 let cpuQuota=null,cpuset=null,limit=null,headroom=null;
 if(platform==='linux'){
  const cgroup=read('/proc/self/cgroup')??'';const root='/sys/fs/cgroup';const roots=[root];
  // A cgroup namespace may expose its own root, rather than the host hierarchy.
  const relative=cgroup.split('\n').find(v=>v.startsWith('0::'))?.slice(3);
  if(relative&&relative.startsWith('/')&&!relative.split('/').includes('..')){let p=path.posix.join(root,relative);while(p!==root&&p.startsWith(root+'/')){roots.push(p);p=path.posix.dirname(p);}}
  for(const dir of new Set(roots)){
   const max=read(dir+'/cpu.max')?.split(/\s+/);if(max?.length===2&&max[0]!=='max')cpuQuota=minimum(cpuQuota,positive(Number(max[0])/Number(max[1])));
   cpuset=minimum(cpuset,cpuListCount(read(dir+'/cpuset.cpus.effective')));
   const memory=integer(dir+'/memory.max');if(memory!==null){limit=minimum(limit,memory);const used=integer(dir+'/memory.current');if(used!==null)headroom=minimum(headroom,Math.max(0,memory-used));}
  }
  // Legacy v1 controllers can be mounted separately; apply every visible cap.
  for(const line of cgroup.split('\n')){const parts=line.split(':');if(parts.length!==3)continue;const controllers=parts[1].split(','),relative=parts[2];if(!relative.startsWith('/')||relative.split('/').includes('..'))continue;for(const controller of controllers){const dirs=[...hierarchy(root+'/'+controller,relative),...hierarchy(root+'/'+parts[1],relative)];for(const dir of new Set(dirs)){
   if(controller==='cpu'){const q=read(dir+'/cpu.cfs_quota_us'),p=read(dir+'/cpu.cfs_period_us');if(q!==null&&p!==null&&Number(q)>0)cpuQuota=minimum(cpuQuota,positive(Number(q)/Number(p)));}
   if(controller==='cpuset')cpuset=minimum(cpuset,cpuListCount(read(dir+'/cpuset.cpus')));
   if(controller==='memory'){const v=integer(dir+'/memory.limit_in_bytes');if(v!==null&&v<2**60){limit=minimum(limit,v);const used=integer(dir+'/memory.usage_in_bytes');if(used!==null)headroom=minimum(headroom,Math.max(0,v-used));}}
  }}}
  const affinity=read('/proc/self/status')?.match(/^Cpus_allowed_list:\s*(.+)$/m)?.[1];cpuset=minimum(cpuset,cpuListCount(affinity));
 }
 const physical=positive(query(()=>system.totalmem())),free=nonnegative(query(()=>system.freemem()));
 const constrained=positive(query(()=>runtime.constrainedMemory()));
 const processUsed=nonnegative(query(()=>runtime.memoryUsage().rss));
 const heapStats=query(heap),heapLimit=positive(heapStats?.heap_size_limit),heapUsed=nonnegative(heapStats?.used_heap_size);
 const total=minimum(physical,limit,constrained,heapLimit),available=minimum(total,free,headroom,heapLimit!==null&&heapUsed!==null?Math.max(0,heapLimit-heapUsed):null,constrained!==null&&processUsed!==null?Math.max(0,constrained-processUsed):null,nonnegative(query(()=>runtime.availableMemory())));
 let diskTotal=null,diskFree=null;const disk=query(()=>statfs(stateDirectory));if(disk){diskTotal=nonnegative(Number(disk.bsize)*Number(disk.blocks));diskFree=nonnegative(Number(disk.bsize)*Number(disk.bavail));}
 let gpuCount=null,gpuTotal=null,gpuAvailable=null,unified=null;const gpus=[];
 if(platform==='linux'){
  const cards=query(()=>readDir('/sys/class/drm'));
  if(cards){const devices=cards.filter(v=>/^card\d+$/.test(v)&&read('/sys/class/drm/'+v+'/device/vendor')!==null);gpuCount=devices.length||null;
   const totals=[],frees=[];for(const card of devices){const p='/sys/class/drm/'+card+'/device';const t=integer(p+'/mem_info_vram_total'),u=integer(p+'/mem_info_vram_used');totals.push(t);const available=t!==null&&u!==null?Math.max(0,t-u):null;frees.push(available);gpus.push({index:gpus.length,compute_units:null,memory_total_bytes:t,memory_available_bytes:available,unified_memory:null});}
   if(devices.length&&totals.every(v=>v!==null))gpuTotal=totals.reduce((a,b)=>a+b,0);if(devices.length&&frees.every(v=>v!==null))gpuAvailable=frees.reduce((a,b)=>a+b,0);
  }
 }
 return {os:platform,arch:architecture,cpu:{logical_count:logical,available_cores:minimum(logical,parallel,cpuQuota,cpuset)},ram:{total_bytes:total,available_bytes:available,process_used_bytes:processUsed},disk:{total_bytes:diskTotal,available_bytes:diskFree},gpu:{count:gpuCount,total_bytes:gpuTotal,available_bytes:gpuAvailable,unified_memory:unified,gpus}};
}

export function collectProfile(capabilities,stateDirectory,dependencies){
 let hardware;try{hardware=collectHardware(stateDirectory,dependencies);}catch{hardware={cpu:{},ram:{},disk:{},gpu:{}};}
 return {schema:1,capabilities:[...capabilities],resources:{cpu_logical_cores:hardware.cpu.logical_count??null,cpu_available_cores:hardware.cpu.available_cores??null,ram_total_bytes:hardware.ram.total_bytes??null,ram_available_bytes:hardware.ram.available_bytes??null,disk_total_bytes:hardware.disk.total_bytes??null,disk_available_bytes:hardware.disk.available_bytes??null,gpu_status:hardware.gpu.gpus?.length?'detected':'unknown',gpus:hardware.gpu.gpus??[]}};
}
export function encodeProfile(profile){return Buffer.from(JSON.stringify(profile),'utf8').toString('base64url');}
