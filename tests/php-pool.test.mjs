import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';import {fixture} from './fixture.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
test('PHP pool keeps root lock, uses two durable slots, drains under pressure, and resumes',async(t)=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-php-pool-'));const state=path.join(dir,'state');fs.mkdirSync(state);let started=0,readyResolve,releaseSource;const ready=new Promise(r=>readyResolve=r),release=new Promise(r=>releaseSource=r);let child,exit;let stderr='';
 const f=await fixture({routes:async(req,res,p)=>{if(!p.startsWith('/pool-source/'))return false;started++;if(started===2)readyResolve();await release;res.writeHead(200,{'Content-Length':4});res.end('data');return true;}});
 try{
  const pressure = path.join(state, 'pressure');
  fs.writeFileSync(pressure, 'owner work');
  const recovered = 'already-finished-attempt';
  fs.writeFileSync(path.join(state, 'state.json'), JSON.stringify({outbox:{
    [recovered]:{job_id:'already-finished',body:{worker_id:'w',attempt_id:recovered,fencing_token:1,status:'succeeded',result:{value:17}}}
  }}));
  const idlePulses = () => f.profileHeaders.filter(h =>
    h.path === '/v1/workers/heartbeat' && h.profile.execution?.max_concurrent_jobs === 0
  ).length;
  const claimCount = () => f.profileHeaders.filter(h => h.path === '/v1/jobs/claim').length;
  const native=!!process.env.PHP_BINARY;const cfg={gateway:f.url,token:'fixture',state_directory:native?state:'/state/state',update_sources:[],heartbeat_seconds:.2,concurrency:{enabled:true},update_poll_seconds:86400};const file=path.join(dir,'config.json');fs.writeFileSync(file,JSON.stringify(cfg));
  for(let i=0;i<3;i++)f.jobs.push({id:'php-pool-'+i,attempt_id:'php-pool-attempt-'+i,fencing_token:1,lease_until:new Date(Date.now()+120000).toISOString(),operation:'http.request',input:{effect_id:'get',url:f.url+'/pool-source/'+i,response:{mode:'artifact'}}});
  const args=native?[path.join(root,'tests/php-pool-driver.php'),file]:['run','--rm','--network','host','--user',String(process.getuid())+':'+String(process.getgid()),'-v',root+':/app:ro','-v',dir+':/state:rw','php:8.3-apache','php','/app/tests/php-pool-driver.php','/state/config.json'];child=spawn(process.env.PHP_BINARY??'docker',args,{stdio:['ignore','pipe','pipe']});child.stdout.resume();child.stderr.on('data',x=>stderr+=x);exit=new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>resolve(code));});
  await t.waitFor(() => assert.ok(idlePulses() >= 2), {timeout: 15000});
  assert.equal(claimCount(), 0);
  assert.equal(started, 0);
  assert.deepEqual(f.completions.map(x=>x.attempt_id),[recovered]);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(state,"state.json"))).outbox),[]);
  assert.ok(f.workerHeartbeats.every(h => h.worker_id === 'w' && h.state === 'idle' && h.capabilities.includes('sha256')));
  fs.unlinkSync(pressure);
  await Promise.race([ready,exit.then(code=>{throw Error('php_pool_exited_'+code+' '+stderr);})]);assert.equal(f.completions.length,1);fs.writeFileSync(pressure,'owner work');await t.waitFor(() => assert.equal(JSON.parse(fs.readFileSync(path.join(state,'scheduler.json'))).execution.max_concurrent_jobs,0),{timeout:15000});releaseSource();
  while(f.completions.length<3)await new Promise(r=>setTimeout(r,20));assert.equal(f.jobs.length,1);
  while([state,path.join(state,'slots/1')].some(d=>Object.keys(JSON.parse(fs.readFileSync(path.join(d,'state.json'))).outbox).length))await new Promise(r=>setTimeout(r,20));
  const beforeIdle=idlePulses(), beforeClaims=claimCount();
  await t.waitFor(() => assert.ok(idlePulses() >= beforeIdle + 2), {timeout: 15000});
  assert.equal(claimCount(),beforeClaims);
  fs.unlinkSync(pressure);while(f.completions.length<4)await new Promise(r=>setTimeout(r,20));fs.writeFileSync(path.join(state,'maintenance'),'stop');assert.equal(await exit,0,stderr);assert.equal(new Set(f.completions.map(x=>x.attempt_id)).size,4);assert.equal(started,3);
  const beforeMaintenance = f.profileHeaders.length;
  const offline = spawn(process.env.PHP_BINARY ?? 'docker', args, {stdio:'ignore'});
  await new Promise((resolve,reject) => {
   offline.once('error',reject);
   offline.once('exit',code => code === 0 ? resolve() : reject(Error('maintenance process failed')));
  });
  assert.equal(f.profileHeaders.length, beforeMaintenance);
 }finally{releaseSource();if(fs.existsSync(state))fs.writeFileSync(path.join(state,'maintenance'),'stop');if(exit)await exit;await f.close();fs.rmSync(dir,{recursive:true,force:true});}
});
