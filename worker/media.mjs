import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, dirname } from "node:path";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { command } from "./process.mjs";
import { fileURLToPath } from "node:url";
import { channelUrl, clipHash, probeResult } from "./core.mjs";
import { pickWindow, snapToSentences } from "./highlights.mjs";
const run=promisify(execFile);
export const streamlink=process.env.STREAMLINK||"streamlink";
const python=process.env.PYTHON||"python", script=name=>fileURLToPath(new URL("./"+name,import.meta.url));
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
// Turns a buffered recording window into the final clip. Chooses the best `settings.duration` seconds inside
// [focusFrom, focusTo] (seconds into `raw`) from loudness plus per-second chat counts, snaps the edges to sentence
// boundaries, frames it vertically and burns in captions. The transcript is made once and reused for captions.
// Removes `raw` and intermediates. Returns { sha, start, end }.
export async function processWindow(raw,{settings,focusFrom=0,focusTo=Infinity,chat=[]},file,signal) {
  const dir=dirname(file), cut=join(dir,"cut.mp4"), energyFile=join(dir,"energy.json"), wordsFile=join(dir,"words.json");
  await mkdir(dir,{recursive:true});
  try {
    if(signal.aborted)throw new Error("Cancelled");
    await command(python,[script("highlight.py"),raw,energyFile],{signal,timeout:120_000}).done;
    const {energy}=JSON.parse(await readFile(energyFile,"utf8"));
    let segments=[];
    try {
      await command(python,[script("captions.py"),"words",raw,wordsFile],{signal,timeout:600_000}).done;
      segments=JSON.parse(await readFile(wordsFile,"utf8")).segments;
    } catch(error) {
      // Sentence snapping is a refinement; only captions make the transcript mandatory.
      if(settings.captions||signal.aborted)throw error;
    }
    const duration=settings.duration, total=energy.length;
    const first=pickWindow({energy,chat,duration,from:Math.max(0,Math.floor(focusFrom)),to:Math.min(total,Math.ceil(focusTo))});
    const {start,end}=snapToSentences(first,first+duration,segments,{minLen:Math.max(15,duration-8),maxLen:Math.min(90,duration+8),total});
    await command("ffmpeg",["-hide_banner","-loglevel","error","-y","-ss",String(start),"-i",raw,"-t",String(end-start),"-vf",frameFilter(settings.framing),"-c:v","libx264","-preset","veryfast","-crf","25","-maxrate","1500k","-bufsize","3000k","-c:a","aac","-b:a","96k","-movflags","+faststart",cut],{signal}).done;
    if(settings.captions) {
      await command(python,[script("captions.py"),"srt",wordsFile,String(start),String(end),join(dir,"captions.srt")],{signal,timeout:60_000}).done;
      const {width,height}=await videoSize(raw,signal);
      // Relative subtitle path: filter syntax treats ':' as a separator, which breaks absolute Windows paths.
      await command("ffmpeg",["-hide_banner","-loglevel","error","-y","-i",cut,"-vf","subtitles=captions.srt:force_style='"+captionStyle(settings.framing,width,height)+"'","-c:v","libx264","-preset","veryfast","-crf","25","-maxrate","1500k","-bufsize","3000k","-c:a","copy","-movflags","+faststart",file],{signal,cwd:dir}).done;
    } else {
      await command("ffmpeg",["-hide_banner","-loglevel","error","-y","-i",cut,"-c","copy",file],{signal}).done;
    }
    const size=(await stat(file)).size;
    if(size<1024||size>32*1024*1024)throw new Error("Clip size outside allowed range");
    const transcript=segments.flatMap(s=>(s.words||[]).filter(w=>w[0]>=start&&w[1]<=end).map(w=>w[2])).join(' ').replace(/\s+/g,' ').trim().slice(0,6000);
    return {sha:clipHash(await readFile(file)),start,end,transcript};
  } finally {
    for(const path of [raw,cut,energyFile,wordsFile,join(dir,"captions.srt")])await rm(path,{force:true});
  }
}
