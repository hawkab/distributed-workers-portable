import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync}from'node:child_process';import {fileURLToPath}from'node:url';import{processLimits,processBudget}from'../node/processes.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
const fixtures={
 '/proc/self/cgroup':'0::/account/worker',
 '/sys/fs/cgroup/pids.max':'max','/sys/fs/cgroup/account/pids.max':'100','/sys/fs/cgroup/account/pids.current':'70','/sys/fs/cgroup/account/worker/pids.max':'200','/sys/fs/cgroup/account/worker/pids.current':'50',
 '/proc/self/limits':'Max processes             80                   80                   processes',
 '/proc/11/status':'Threads:\t9\n','/proc/12/status':'Threads:\t21\n'
};
const dependencies={platform:()=> 'linux',uid:()=>1000,read:p=>{if(!(p in fixtures))throw Object.assign(Error('missing'),{code:'ENOENT'});return fixtures[p];},list:()=>['11','12','13','sys'],stat:p=>({uid:p.endsWith('/13')?2000:1000})};
test('process admission combines enclosing cgroups and per-user thread count',()=>{const limits=processLimits(dependencies);assert.deepEqual(limits,[{max:200,used:50},{max:100,used:70},{max:80,used:30}]);assert.equal(processBudget(20,2,limits),2);});
test('exhaustion drains admission, released threads resume it, and unknown platform adds no invented cap',()=>{assert.equal(processBudget(20,4,[{max:100,used:95}]),2);assert.equal(processBudget(20,0,[{max:100,used:95}]),0);assert.equal(processBudget(20,0,[{max:100,used:30}]),2);assert.equal(processBudget(20,0,[]),20);assert.deepEqual(processLimits({platform:()=> 'win32'}),[]);});
test('unknown accounting remains conservative; reservation is operator adjustable',()=>{assert.equal(processBudget(20,0,[{max:100,used:null}]),1);assert.equal(processBudget(20,0,[{max:100,used:30}],{perJob:8,reserveFraction:.25}),5);});
test('PHP uses the same actual cgroup/user accounting and thread headroom',()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-pids-'));try{fs.writeFileSync(path.join(dir,'input.json'),JSON.stringify(fixtures));const native=!!process.env.PHP_BINARY;const args=native?[path.join(root,'tests/php-processes-driver.php'),path.join(dir,'input.json')]:['run','--rm','--user',String(process.getuid())+':'+String(process.getgid()),'-v',root+':/app:ro','-v',dir+':/state:ro','php:8.3-apache','php','/app/tests/php-processes-driver.php','/state/input.json'];const r=spawnSync(process.env.PHP_BINARY??'docker',args,{encoding:'utf8'});assert.equal(r.status,0,r.stderr);assert.deepEqual(JSON.parse(r.stdout),{limits:processLimits(dependencies),budget:2,exhausted:0,recovered:2});}finally{fs.rmSync(dir,{recursive:true,force:true});}});

test('sufficient kernel-wide headroom skips enumerating each UID process',()=>{
 let lists=0;
 const measure=(total,limit)=>processLimits({...dependencies,
  read:p=>p==='/proc/loadavg'?'0 0 0 1/'+total+' 42':p==='/proc/self/limits'?'Max processes  '+limit+'  '+limit+'  processes':dependencies.read(p),
  list:()=>{lists++;return dependencies.list();},
  headroom:{needed:64,reserveFraction:.25}
 });
 assert.equal(measure(100,1000).at(-1).used,100);assert.equal(lists,0);
 assert.equal(measure(100,180).at(-1).used,30);assert.equal(lists,1);
});
