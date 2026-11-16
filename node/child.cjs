'use strict';
const fs=require('node:fs'),vm=require('node:vm');
// libuv may inject Windows startup variables even when the launcher passes env:{}.
// Remove them after Node has started, before any task code can inspect the process.
for(const key of Object.keys(process.env))delete process.env[key];
let pending=Buffer.alloc(0),sequence=0;
const sleeper=new Int32Array(new SharedArrayBuffer(4));
function read(){const parts=[];let bytes=0;for(;;){const end=pending.indexOf(10);if(end>=0){parts.push(pending.subarray(0,end));const line=Buffer.concat(parts,bytes+end);pending=pending.subarray(end+1);return JSON.parse(line.toString('utf8'));}if(pending.length){parts.push(pending);bytes+=pending.length;pending=Buffer.alloc(0);}const chunk=Buffer.allocUnsafe(65536);let n;try{n=fs.readSync(0,chunk,0,chunk.length,null);}catch(e){if(e.code==='EAGAIN'||e.code==='EWOULDBLOCK'){Atomics.wait(sleeper,0,0,1);continue;}throw e;}if(!n)throw Error('parent_closed');pending=chunk.subarray(0,n);}}
function send(value){const bytes=Buffer.from(JSON.stringify(value)+'\n');let offset=0;while(offset<bytes.length){try{offset+=fs.writeSync(1,bytes,offset,bytes.length-offset);}catch(e){if(e.code==='EAGAIN'||e.code==='EWOULDBLOCK'){Atomics.wait(sleeper,0,0,1);continue;}throw e;}}}
function rpc(method,args){const id=++sequence;send({rpc:id,method,args});const response=read();if(response.rpc!==id)throw Error('host_rpc_mismatch');if(response.error){const error=Error(response.error);if(response.code)error.code=response.code;if(response.status)error.status=response.status;throw error;}return response.result;}
try{const job=read();const ctx=Object.freeze({progress:x=>rpc('progress',x),checkpoint:x=>rpc('checkpoint',x),http:Object.freeze({request:x=>rpc('http.request',x)}),cancelled:()=>rpc('cancelled',null)});const scope=vm.createContext({input:job.input,resume:job.resume,ctx,progress:ctx.progress,checkpoint:ctx.checkpoint});const script=new vm.Script('"use strict";\n'+job.script+'\n;run(input,resume,ctx);',{filename:'portable-task.js'});const result=script.runInContext(scope);if(result&&typeof result.then==='function')throw Error('portable_javascript_must_be_synchronous');send({result:result===undefined?null:result});}
catch(e){send({error:typeof e.message==='string'?e.message:'javascript_failed',code:e.code,status:e.status});process.exitCode=1;}
