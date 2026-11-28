import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';import {spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';import {fixture} from './fixture.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
test('two real native jobs coexist, pressure drains them, and admission resumes without state collision',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-pool-'));const release=path.join(dir,'release'),pressure=path.join(dir,'pressure'),config=path.join(dir,'config.json');let process,output='',failure='',readyResolve,pausedResolve;const ready=new Promise(r=>readyResolve=r),paused=new Promise(r=>pausedResolve=r);const started=new Set();
 const f=await fixture({routes:async(req,res,p)=>{const m=/\/jobs\/([^/]+)\/artifacts$/.exec(p);if(m){started.add(m[1]);if(started.size===2)readyResolve();}return false;}});
 try{
  const executable=globalThis.process.execPath;const code="const fs=require('node:fs');process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write('abcd');const t=setInterval(()=>{if(fs.existsSync("+JSON.stringify(release)+")){clearInterval(t);process.stdout.write('efgh');}},10);});";
  const c={gateway:f.url,token:'fixture',state_directory:path.join(dir,'state'),poll_ms:1,update_poll_seconds:86400,commands:{fixed:{executable,argv:['-e',code],sha256:crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex'),capability:'program.pool.fixture',replay:'safe'}}};fs.writeFileSync(config,JSON.stringify(c));fs.mkdirSync(c.state_directory,{recursive:true});fs.writeFileSync(path.join(c.state_directory,'state.json'),JSON.stringify({schema:1,outbox:{},transfers:{},checkpoints:{},update_check_at:Date.now()}));
  for(let n=0;n<3;n++)f.jobs.push({id:'pool-'+n,attempt_id:'pool-attempt-'+n,fencing_token:1,operation:'command.run',input:{program:'fixed',payload:{}},lease_until:new Date(Date.now()+120000).toISOString()});
  const script=path.join(dir,'run.mjs');fs.writeFileSync(script,`import fs from 'node:fs';import {runPool}from ${JSON.stringify(new URL('../node/pool.mjs',import.meta.url).href)};import{collectProfile}from ${JSON.stringify(new URL('../node/hardware.mjs',import.meta.url).href)};const c=JSON.parse(fs.readFileSync(process.argv[2]));const admission={execution:{max_concurrent_jobs:2,mode:'shared'},sample(){this.execution.max_concurrent_jobs=fs.existsSync(${JSON.stringify(pressure)})?0:2;if(this.execution.max_concurrent_jobs===0)console.log('paused');return this.execution;},profile(c,d){return {...collectProfile(c,d),execution:this.execution};}};await runPool(c,{admission});`);
  process=spawn(executable,[script,config],{stdio:['ignore','pipe','pipe']});process.stdout.on('data',b=>{output+=b;if(output.includes('paused'))pausedResolve();});process.stderr.on('data',b=>failure+=b);const exit=new Promise((resolve,reject)=>{process.on('error',reject);process.on('exit',code=>resolve(code));});
  await Promise.race([ready,exit.then(code=>{throw Error('pool_exited_'+code+' '+failure);})]);assert.equal(f.completions.length,0);fs.writeFileSync(pressure,'owner busy');await paused;fs.writeFileSync(release,'finish');
  while(f.completions.length<2)await new Promise(r=>setTimeout(r,20));assert.equal(f.jobs.length,1);assert.equal(new Set(f.completions.map(x=>x.attempt_id)).size,2);
  // The fixture receives completion before its HTTP acknowledgement reaches
  // the worker. Wait for both durable local acknowledgements, not that earlier
  // server event, before inspecting the recovered slot states.
  for (const file of [path.join(c.state_directory,'state.json'),path.join(c.state_directory,'slots/1/state.json')]) {
   while (true) {
    const state=JSON.parse(fs.readFileSync(file));
    if (!state.active && Object.keys(state.outbox??{}).length===0) break;
    await Promise.race([new Promise(r=>setTimeout(r,20)),exit.then(code=>{throw Error('pool_exited_before_ack_'+code+' '+failure);})]);
   }
  }
  fs.unlinkSync(pressure);while(f.completions.length<3)await new Promise(r=>setTimeout(r,20));fs.writeFileSync(path.join(c.state_directory,'runtime-stop'),'stop');assert.equal(await exit,0,failure);assert.equal(new Set(f.completions.map(x=>x.attempt_id)).size,3);assert.equal(f.connections.every(x=>x.profile.execution!==undefined),true);
 }finally{fs.writeFileSync(release,'finish');if(process&&process.exitCode===null)process.kill('SIGTERM');await f.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('aborted idle claim releases the update barrier and can claim again',async()=>{
 const {Worker}=await import('../node/worker.mjs');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-claim-abort-'));let reached;const ready=new Promise(r=>reached=r);let held=true;
 const f=await fixture({routes:async(req,res,p)=>{if(p==='/v1/jobs/claim'&&held){for await(const _ of req){}reached();req.socket.once('close',()=>res.destroy());return true;}return false;}});
 const w=new Worker({gateway:f.url,token:'fixture',state_directory:dir});w.store.lock();
 try { const tick=w.tick();const failed=assert.rejects(tick);await ready;w.stopAdmission();await failed;assert.equal(w.claimController,undefined);held=false;w.accepting=true;assert.equal(await w.tick(),false);assert.equal(w.claimController,undefined); }
 finally{w.store.unlock();await f.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('a zero-slot pool announces presence without claiming, then uses the same identity for work', async () => {
 const {runPool} = await import('../node/pool.mjs');
 const {collectProfile} = await import('../node/hardware.mjs');
 const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-zero-presence-'));
 const stop = path.join(directory, 'runtime-stop');
 const f = await fixture({routes: async (req, res, route) => {
  if (route.endsWith('/complete')) fs.writeFileSync(stop, 'stop');
  if (route === '/v1/jobs/claim' && fs.existsSync(stop)) {
   req.resume();
   req.socket.once('close', () => res.destroy());
   return true;
  }
  return false;
 }});
 try {
  const config = {gateway:f.url,token:'fixture',state_directory:directory,heartbeat_ms:100, trusted_javascript:true};
  fs.writeFileSync(path.join(directory,'state.json'), JSON.stringify({schema:1,outbox:{},transfers:{},checkpoints:{},update_check_at:Date.now()}));
  f.jobs.push({id:'held-job',attempt_id:'held-attempt',fencing_token:1,operation:'sha256',input:{text:'reserved'},
   lease_until:new Date(Date.now()+120000).toISOString()});
  let samples = 0;
  const admission = {
   execution:{max_concurrent_jobs:0, mode:'shared'},
   sample() { this.execution.max_concurrent_jobs = ++samples < 4 ? 0 : 1; },
   profile(capabilities, dir) { return {...collectProfile(capabilities,dir),execution:this.execution}; }
  };
  await runPool(config,{admission});
  const paused = f.profileHeaders.filter(h => h.profile.execution.max_concurrent_jobs === 0);
  assert.ok(paused.length >= 2);
  assert.ok(paused.every(h => h.path === '/v1/workers/heartbeat' && h.profile.capabilities.includes('javascript.portable.v1')));
  assert.equal(f.connections.length,1);
  assert.equal(f.connections[0].profile.execution.max_concurrent_jobs,0);
  assert.ok(f.workerHeartbeats.every(h => h.worker_id === 'w' && h.state === 'idle'));
  assert.deepEqual(f.completions.map(c => [c.worker_id,c.attempt_id]), [['w','held-attempt']]);
  const eventsBeforeStop = [f.connections.length,f.workerHeartbeats.length,f.profileHeaders.length];
  await runPool(config,{admission});
  assert.deepEqual([f.connections.length,f.workerHeartbeats.length,f.profileHeaders.length],eventsBeforeStop);
 } finally { await f.close(); fs.rmSync(directory,{recursive:true,force:true}); }
});
