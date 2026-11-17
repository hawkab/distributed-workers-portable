import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {fixture} from './fixture.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
function start(script,args=[],options={}){
 const native=!!process.env.PHP_BINARY;
 const mapped=value=>value.startsWith(options.directory+'/')?'/state/'+path.relative(options.directory,value):value.startsWith(root)?'/app/'+path.relative(root,value):value;
 const command=native?process.env.PHP_BINARY:'docker';
 const commandArgs=native?[...(options.ini??[]),script,...args]:['run','-i','--rm','--network','host','--user',String(process.getuid())+':'+String(process.getgid()),'-v',root+':/app:ro','-v',options.directory+':/state:rw','php:8.3-apache','php',...(options.ini??[]),mapped(script),...args.map(mapped)];
 const child=spawn(command,commandArgs,{stdio:['pipe','pipe','pipe']});
 let stdout='',stderr='';child.stdout.on('data',part=>stdout+=part);child.stderr.on('data',part=>stderr+=part);
 const done=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));});
 return {process:child,done};
}
function setup(f){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-php-bootstrap-')),state=path.join(dir,'state');fs.mkdirSync(state,{mode:0o700});
 const config=path.join(dir,'config.json');fs.writeFileSync(config,JSON.stringify({gateway:f.url,token:'bootstrap-fixture',state_directory:process.env.PHP_BINARY?state:'/state/state',update_sources:[]}),{mode:0o600});
 f.workerIds.set('Bearer bootstrap-fixture','php-bootstrap-fixture');return {dir,state,config};
}
function job(n){return {id:'bootstrap-'+n,attempt_id:'attempt-'+n,fencing_token:1,lease_until:new Date(Date.now()+120000).toISOString(),operation:'sha256',input:{text:'payload-'+n}};}

test('PHP canonical cron bootstrap drains ready jobs and leaves on actual empty queue',async()=>{
 const f=await fixture(),s=setup(f);try{
  f.jobs.push(job(1),job(2),job(3));
  const result=await start(path.join(root,'php/bootstrap.php'),[s.config,'--drain'],{directory:s.dir}).done;
  assert.equal(result.code,0,result.stderr);assert.equal(f.completions.length,3);assert.equal(f.jobs.length,0);
  assert.equal(f.connections.length,1);assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(s.state,'state.json'))).outbox).length,0);
 }finally{await f.close();fs.rmSync(s.dir,{recursive:true,force:true});}
});

test('PHP overlapping cron does not read or overwrite state before obtaining lock',async()=>{
 const f=await fixture(),s=setup(f);let holder;
 try{
  fs.writeFileSync(path.join(s.state,'state.json'),'not valid JSON while another process owns state');
  const script=path.join(s.dir,'hold.php');fs.writeFileSync(script,'<?php $f=fopen($argv[1],"c+");flock($f,LOCK_EX);fwrite(STDOUT,"ready");fflush(STDOUT);fread(STDIN,1);');
  holder=start(script,[path.join(s.state,'php-worker.lock')],{directory:s.dir});await once(holder.process.stdout,'data');
  const result=await start(path.join(root,'php/bootstrap.php'),[s.config,'--drain'],{directory:s.dir}).done;
  assert.equal(result.code,0,result.stderr);assert.equal(result.stderr,'');assert.equal(f.connections.length,0);
  assert.equal(fs.readFileSync(path.join(s.state,'state.json'),'utf8'),'not valid JSON while another process owns state');
 }finally{if(holder){holder.process.stdin.end('x');await holder.done;}await f.close();fs.rmSync(s.dir,{recursive:true,force:true});}
});

test('PHP once compatibility executes one ready task rather than the whole batch',async()=>{
 const f=await fixture(),s=setup(f);try{
  f.jobs.push(job(1),job(2));const result=await start(path.join(root,'php/bootstrap.php'),[s.config,'--once'],{directory:s.dir}).done;
  assert.equal(result.code,0,result.stderr);assert.equal(f.completions.length,1);assert.equal(f.jobs.length,1);
 }finally{await f.close();fs.rmSync(s.dir,{recursive:true,force:true});}
});

test('PHP new authenticated bootstrap does not select an older installed runtime',async()=>{
 const f=await fixture(),s=setup(f);try{
  const version=JSON.parse(fs.readFileSync(path.join(root,'VERSION.json'))),older=version.code-1,directory=path.join(s.state,'runtime',String(older));fs.mkdirSync(directory,{recursive:true});
  const hash='a'.repeat(64);fs.writeFileSync(path.join(directory,'.installed.json'),JSON.stringify({version_code:older,sha256:hash}));
  fs.mkdirSync(path.join(directory,'php'));fs.writeFileSync(path.join(directory,'php/worker.php'),'<?php throw new RuntimeException("older_runtime_selected");');
  fs.writeFileSync(path.join(s.state,'state.json'),JSON.stringify({schema:1,outbox:[],transfers:[],checkpoints:[],update:{current_code:older,sha256:hash}}));
  const result=await start(path.join(root,'php/bootstrap.php'),[s.config,'--drain'],{directory:s.dir}).done;
  assert.equal(result.code,0,result.stderr);assert.equal(f.workerHeartbeats[0].version_code,version.code);
 }finally{await f.close();fs.rmSync(s.dir,{recursive:true,force:true});}
});
