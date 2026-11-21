import { spawn } from "node:child_process";
const TAIL_CHARS=4000;
// Keeps the end of a stream's text output, for error messages.
export function tail(stream) {
  const state={text:""};
  stream?.setEncoding?.("utf8");
  stream?.on("data",chunk=>{state.text=(state.text+chunk).slice(-TAIL_CHARS);});
  return state;
}
// The last meaningful lines of tool output, e.g. a Python traceback's final error line.
export function lastLines(text,count=2,max=300) {
  // Lines with no letters or digits (")", "^^^^", "~~~") are layout from tracebacks, not information.
  const lines=String(text).split(/\r?\n/).map(l=>l.trim()).filter(l=>/[\p{L}\p{N}]/u.test(l));
  return lines.slice(-count).join(" | ").slice(-max);
}
// `env`: the child's environment (default: this process's), e.g. to pick a different Whisper model for one run.
export function command(binary,args,{signal,timeout=300_000,stdout="ignore",cwd,env}={}) {
  const child=spawn(binary,args,{stdio:["ignore",stdout,"pipe"],windowsHide:true,cwd,...(env&&{env})});
  const stderr=tail(child.stderr);
  const name=String(binary).split(/[\\/]/).pop();
  const done=new Promise((resolve,reject)=>{
    let finished=false,timedOut=false,killTimer;
    const finish=(error)=>{
      if(finished)return;
      finished=true;clearTimeout(timer);clearTimeout(killTimer);signal?.removeEventListener("abort",abort);
      if(error)reject(error);else resolve();
    };
    const abort=()=>{child.kill("SIGTERM");killTimer=setTimeout(()=>child.kill("SIGKILL"),3000);};
    const timer=setTimeout(()=>{timedOut=true;abort();},timeout);
    child.once("error",error=>finish(new Error(name+" could not start ("+(error.code??error.message)+")")));
    // "close" waits for stderr to drain, so the message includes the tool's last words.
    child.once("close",code=>{
      if(code===0&&!signal?.aborted&&!timedOut)return finish(null);
      const why=signal?.aborted?"was cancelled":timedOut?"timed out after "+Math.round(timeout/1000)+"s":"failed (exit "+code+")";
      const detail=lastLines(stderr.text);
      finish(new Error(name+" "+why+(detail?": "+detail:"")));
    });
    signal?.addEventListener("abort",abort,{once:true});if(signal?.aborted)abort();
  });
  return {child,done};
}
