import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const childPath=fileURLToPath(new URL('./child.cjs',import.meta.url));
export function javascript(job,resume,host,{signal}={}){return new Promise((resolve,reject)=>{
 // Trusted operator code only. Node vm AND permissions are not hostile-code sandboxes.
 const child=spawn(process.execPath,['--permission','--allow-fs-read='+childPath,childPath],{env:{},stdio:['pipe','pipe','pipe'],windowsHide:true});let text='',settled=false,chain=Promise.resolve();
 const finish=(error,result)=>{if(settled)return;settled=true;signal?.removeEventListener('abort',abort);child.kill('SIGKILL');error?reject(error):resolve(result);};
 const abort=()=>finish(new Error(signal?.reason?.message??'cancelled'));if(signal?.aborted){abort();return;}signal?.addEventListener('abort',abort,{once:true});
 child.on('error',e=>finish(e));child.on('exit',code=>{if(!settled)finish(new Error('javascript_child_exited_'+code));});child.stderr.resume();
 child.stdout.setEncoding('utf8');child.stdout.on('data',data=>{text+=data;for(;;){const n=text.indexOf('\n');if(n<0)break;const line=text.slice(0,n);text=text.slice(n+1);chain=chain.then(async()=>{const message=JSON.parse(line);if(message.rpc){try{const result=await host(message.method,message.args);if(!settled)child.stdin.write(JSON.stringify({rpc:message.rpc,result:result??null})+'\n');}catch(e){if(!settled)child.stdin.write(JSON.stringify({rpc:message.rpc,error:e.message,code:e.code,status:e.status})+'\n');}}else if(message.error){const e=new Error(message.error);if(message.code)e.code=message.code;if(message.status)e.status=message.status;finish(e);}else if('result'in message)finish(null,message.result);}).catch(finish);}});
 child.stdin.on('error',e=>{if(!settled)finish(e);});child.stdin.write(JSON.stringify({input:job.input,resume,script:job.script})+'\n');
});}
