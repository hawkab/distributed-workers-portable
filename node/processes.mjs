import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
// Linux NPROC and cgroup pids account for threads as well as processes.
export function processLimits({read=p=>fs.readFileSync(p,'utf8'),list=p=>fs.readdirSync(p),stat=p=>fs.statSync(p),uid=()=>process.getuid?.(),platform=()=>os.platform(),headroom}={}){
 if(platform()!=='linux')return [];
 const text=p=>{try{return read(p).trim();}catch{return null;}};const number=p=>{const s=text(p);return s!==null&&/^\d+$/.test(s)?Number(s):null;};const limits=[],dirs=new Set(['/sys/fs/cgroup']);
 const groups=text('/proc/self/cgroup')??'';
 for(const line of groups.split('\n')){const [id,controllers,relative]=line.split(':');if(!relative?.startsWith('/')||relative.split('/').includes('..'))continue;for(const base of id==='0'?['/sys/fs/cgroup']:controllers.split(',').includes('pids')?['/sys/fs/cgroup/pids']:[]){let p=path.posix.join(base,relative);dirs.add(base);while(p!==base&&p.startsWith(base+'/')){dirs.add(p);p=path.posix.dirname(p);}}}
 for(const d of dirs){const max=number(d+'/pids.max');if(max!==null)limits.push({max,used:number(d+'/pids.current')});}
 const user=uid(),match=text('/proc/self/limits')?.match(/^Max processes\s+(\d+)\s+/m);
 if(user!==undefined&&user!==0&&match){
  const max=Number(match[1]);
  // The kernel's total thread count bounds every single UID. Near its limit,
  // or with a substituted loadavg mount, retain exact per-UID enumeration.
  if(headroom){
   const load=text('/proc/loadavg')?.match(/^\S+\s+\S+\s+\S+\s+\d+\/(\d+)\s/);
   const all=load?Number(load[1]):0;
   if(Number.isSafeInteger(all)&&all>0&&max-Math.ceil(max*headroom.reserveFraction)-all>=headroom.needed){
    try{if(stat('/proc/loadavg').dev===stat('/proc/self/limits').dev){limits.push({max,used:all});return limits;}}catch{}
   }
  }
  let used=0,known=true;let entries;try{entries=list('/proc');}catch{known=false;entries=[];}
  for(const id of entries){if(!/^\d+$/.test(id))continue;try{if(stat('/proc/'+id).uid!==user)continue;const status=text('/proc/'+id+'/status');if(status===null){known=false;continue;}const count=status.match(/^Threads:\s+(\d+)/m);if(!count){known=false;continue;}used+=Number(count[1]);}catch(e){if(e.code!=='ENOENT'&&e.code!=='ESRCH')known=false;}}
  limits.push({max:Number(match[1]),used:known?used:null});
 }
 return limits;
}
export function processBudget(slots,active,limits,{perJob=16,reserveFraction=.25}={}){
 for(const {max,used}of limits){if(used===null){slots=Math.min(slots,1);continue;}const reserve=Math.ceil(max*reserveFraction);const absolute=Math.max(0,Math.floor((max-reserve)/perJob));const headroom=active+Math.floor((max-used-reserve)/perJob);slots=Math.max(0,Math.min(slots,absolute,headroom));}return slots;
}
