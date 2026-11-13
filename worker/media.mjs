import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { join, dirname } from "node:path";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { command } from "./process.mjs";
import { fileURLToPath } from "node:url";
import { channelUrl, clipHash, probeResult } from "./core.mjs";
const run=promisify(execFile), streamlink=process.env.STREAMLINK||"streamlink", python=process.env.PYTHON||"python", script=name=>fileURLToPath(new URL("./"+name,import.meta.url));
// 720x1280 output. "blur" fills the bars with a blurred, darkened copy (blurred at low resolution for speed).
export function frameFilter(framing) {
  const fit="scale=720:1280:force_original_aspect_ratio=decrease", fill="scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280";
  if(framing==="crop")return fill+",setsar=1";
  if(framing==="fit")return fit+",pad=720:1280:(ow-iw)/2:(oh-ih)/2,setsar=1";
  return "split[bg][fg];[bg]"+fill+",scale=180:320,boxblur=8:2,eq=brightness=-0.12,scale=720:1280[bg];[fg]"+fit+"[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1";
}
// libass style in 720x1280 pixel units. Captions go just under the picture when there is room, else the lower third.
export function captionStyle(framing,width,height) {
  const base="PlayResX=720,PlayResY=1280,FontName=DejaVu Sans,FontSize=54,Bold=1,Outline=4,Shadow=0,MarginL=40,MarginR=40";
  const shown=framing!=="crop"&&width>0&&height>0?Math.min(1280,Math.round(720*height/width)):1280, below=(1280-shown)/2;
  return below>=200?base+",Alignment=8,MarginV="+Math.round(1280-below+36):base+",Alignment=2,MarginV=300";
}
// Asks streamlink whether the channel has playable streams, without downloading any media.
export async function probeLive(url,signal) {
  let stdout;
  try { ({stdout}=await run(streamlink,["--json","--http-timeout","15",channelUrl(url)],{signal,timeout:45_000,windowsHide:true,maxBuffer:1<<20})); }
  catch (error) { stdout=error.stdout; }  // streamlink exits 1 for offline channels but still prints JSON.
  try { return probeResult(JSON.parse(stdout||"null")); } catch { return probeResult(null); }
}
async function videoSize(file,signal) {
  try {
    const {stdout}=await run("ffprobe",["-v","error","-select_streams","v:0","-show_entries","stream=width,height","-of","csv=p=0:s=x",file],{signal,timeout:30_000,windowsHide:true});
    const [width,height]=stdout.trim().split("x").map(Number);
    return {width,height};
  } catch { return {width:0,height:0}; }
}
export async function captureClip(streamer,settings,file,signal) {
  const dir=dirname(file);await mkdir(dir,{recursive:true});
  const raw=join(dir,"capture.ts");
  const duration=settings.duration,window=Math.min(180,Math.max(90,duration*2));
  const source=spawn(streamlink,["--loglevel","error","--http-timeout","15","--stream-timeout","25","--stdout",channelUrl(streamer.url),"720p,720p60,480p,best"],{stdio:["ignore","pipe","ignore"],windowsHide:true});
  // Capture binary media via the pipe, never interpolate URLs into a shell.
  const capture=spawn("ffmpeg",["-hide_banner","-loglevel","error","-y","-i","pipe:0","-t",String(window),"-map","0:v:0","-map","0:a:0?","-c","copy","-f","mpegts",raw],{stdio:["pipe","ignore","ignore"],windowsHide:true});
  let forcedKill;
  const stop=()=>{source.kill("SIGTERM");capture.kill("SIGTERM");forcedKill=setTimeout(()=>{source.kill("SIGKILL");capture.kill("SIGKILL");},3000);};
  const timer=setTimeout(stop,(window+90)*1000);
  signal.addEventListener("abort",stop,{once:true});
  source.stdout.on("error",()=>{});capture.stdin.on("error",()=>{});
  source.stdout.pipe(capture.stdin);
  try {
    await new Promise((resolve,reject)=>{
      source.once("error",()=>reject(new Error("Stream reader unavailable")));
      capture.once("error",()=>reject(new Error("Capture process unavailable")));
      capture.once("exit",code=>code===0&&!signal.aborted?resolve():reject(new Error("Channel offline, inaccessible, or capture cancelled")));
      if(signal.aborted)stop();
    });
  } finally {clearTimeout(timer);stop();signal.removeEventListener("abort",stop);}
  // The producer is no longer needed after the bounded capture completes.
  await new Promise(resolve=>setTimeout(resolve,3100));clearTimeout(forcedKill);
  return processCapture(raw,settings,file,signal);
}
// Turns a raw capture into the final clip and returns its SHA-256. Removes the raw capture and intermediates.
export async function processCapture(raw,settings,file,signal) {
  const dir=dirname(file), cut=join(dir,"cut.mp4"), duration=settings.duration;
  try {
    if(signal.aborted)throw new Error("Cancelled");
    await command(python,[script("highlight.py"),raw,String(duration),join(dir,"selection.json")],{signal,timeout:90_000}).done;
    const selection=JSON.parse(await readFile(join(dir,"selection.json"),"utf8"));
    const start=Number.isFinite(selection.start)?Math.max(0,selection.start):0;
    await command("ffmpeg",["-hide_banner","-loglevel","error","-y","-ss",String(start),"-i",raw,"-t",String(duration),"-vf",frameFilter(settings.framing),"-c:v","libx264","-preset","veryfast","-crf","25","-maxrate","1500k","-bufsize","3000k","-c:a","aac","-b:a","96k","-movflags","+faststart",cut],{signal}).done;
    if(settings.captions) {
      await command(python,[script("captions.py"),cut,join(dir,"captions.srt")],{signal,timeout:600_000}).done;
      const {width,height}=await videoSize(raw,signal);
      // Relative subtitle path: filter syntax treats ':' as a separator, which breaks absolute Windows paths.
      await command("ffmpeg",["-hide_banner","-loglevel","error","-y","-i",cut,"-vf","subtitles=captions.srt:force_style='"+captionStyle(settings.framing,width,height)+"'","-c:v","libx264","-preset","veryfast","-crf","25","-maxrate","1500k","-bufsize","3000k","-c:a","copy","-movflags","+faststart",file],{signal,cwd:dir}).done;
    } else {
      await command("ffmpeg",["-hide_banner","-loglevel","error","-y","-i",cut,"-c","copy",file],{signal}).done;
    }
    const size=(await stat(file)).size;
    if(size<1024||size>32*1024*1024)throw new Error("Clip size outside allowed range");
    return clipHash(await readFile(file));
  } finally {
    for(const path of [raw,cut,join(dir,"selection.json"),join(dir,"captions.srt")])await rm(path,{force:true});
  }
}
