import { spawn } from "node:child_process";
export function command(binary,args,{signal,timeout=300_000,stdout="ignore",cwd}={}) {
  const child=spawn(binary,args,{stdio:["ignore",stdout,"ignore"],windowsHide:true,cwd});
  const done=new Promise((resolve,reject)=>{
    let finished=false;
    const finish=(error)=>{if(finished)return;finished=true;clearTimeout(timer);clearTimeout(killTimer);signal?.removeEventListener("abort",abort);error?reject(error):resolve();};
    let killTimer;
    const abort=()=>{child.kill("SIGTERM");killTimer=setTimeout(()=>child.kill("SIGKILL"),3000);};
    const timer=setTimeout(abort,timeout);
    child.once("error",()=>finish(new Error(binary+" could not start")));
    child.once("exit",code=>finish(code===0&&!signal?.aborted?null:new Error(binary+" failed or was cancelled")));
    signal?.addEventListener("abort",abort,{once:true});if(signal?.aborted)abort();
  });
  return {child,done};
}
