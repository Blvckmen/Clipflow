import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { command } from "./process.mjs";
import { fileURLToPath } from "node:url";
import { channelUrl, clipHash, probeResult } from "./core.mjs";
import { candidateWindows, chooseMoment, pickWindow, snapToSentences } from "./highlights.mjs";
import { defaultEdit, defaultStyle, maskWord, normalizeStyle } from "./edit.mjs";
import { encodeTimeout, findPhonePicture, renderClip, videoInfo } from "./render.mjs";
import { applyAutomaticHook } from "./hooks.mjs";
import { transcribe as whisper } from "./whisper.mjs";
const run=promisify(execFile);
export const streamlink=process.env.STREAMLINK||"streamlink";
const python=process.env.PYTHON||"python", script=name=>fileURLToPath(new URL("./"+name,import.meta.url));
// Seconds of extra footage kept either side of the chosen moment, so the editor can widen the trim.
export const SOURCE_PAD=6;
// Asks streamlink whether the channel has playable streams, without downloading any media. A Twitch check takes
// 10-20 seconds and can take much longer on a slow connection or a busy machine, so it gets a generous limit.
export const PROBE_TIMEOUT_MS=90_000;
export async function probeLive(url,signal) {
  let stdout,failure=null;
  try { ({stdout}=await run(streamlink,["--json","--http-timeout","20",channelUrl(url)],{signal,timeout:PROBE_TIMEOUT_MS,windowsHide:true,maxBuffer:1<<20})); }
  catch (error) {
    stdout=error.stdout;  // streamlink exits 1 for offline channels but still prints JSON.
    failure=error.killed||error.name==="AbortError"?"streamlink took longer than "+PROBE_TIMEOUT_MS/1000+"s"
     :error.code==="ENOENT"?"streamlink not found ("+streamlink+"); set STREAMLINK to its full path"
     :String(error.stderr||"").trim().split(/\r?\n/).pop()||error.message||null;
  }
  let result;
  try { result=probeResult(JSON.parse(stdout||"null")); } catch { result=probeResult(null); }
  // Say why there was no answer, rather than only that there wasn't one.
  if(result.status==="error"&&!stdout&&failure)result.message=failure.slice(0,300);
  return result;
}
// Transcript words inside [from, to] of the window, shifted so 0 is `from`: [[start, end, text], ...].
// `messages` are [seconds into the raw window, name, text, colour]; keeps those inside [from, to], shifted to the source's
// start, at most 400 (spread evenly over a very busy chat).
export function sourceMessages(messages,from,to) {
  const inside=(messages??[]).filter(m=>m[0]>=from&&m[0]<=to).map(([t,name,text,color])=>[Math.round((t-from)*100)/100,String(name??"").slice(0,25),String(text??"").slice(0,200),color??null]);
  if(inside.length<=400)return inside;
  return Array.from({length:400},(_,i)=>inside[Math.floor(i*inside.length/400)]);
}
// The last keyframe at or before `t` seconds into `file`, or null when there's none in the 20 seconds before it.
export async function keyframeAt(file,t,signal){
  try {
    const {stdout}=await run("ffprobe",["-v","error","-select_streams","v:0","-skip_frame","nokey","-show_entries","frame=pts_time:format=start_time","-of","json","-read_intervals",Math.max(0,t-20)+"%"+(t+1),file],{timeout:60_000,signal,windowsHide:true});
    const json=JSON.parse(stdout),offset=Number(json.format?.start_time)||0;
    const keys=(json.frames??[]).map(x=>Number(x.pts_time)-offset).filter(k=>Number.isFinite(k)&&k<=t+0.01);
    return keys.length?Math.max(0,Math.max(...keys)):null;
  } catch { return null; }
}
// The editable source is the stream's own video, copied (no encode, about half a minute less per clip), when that copy
// stays under SOURCE_COPY_MAX bytes (the dashboard takes sources up to 64 MB) and starts at a keyframe close before the
// moment; otherwise it's re-encoded to at most 1280 pixels as before. SOURCE_COPY=off always re-encodes.
export const SOURCE_COPY_MAX=40*1024*1024;
export function copyPlan({rawBytes,rawSeconds,from,to,keyframe,limit=SOURCE_COPY_MAX}){
  if((process.env.SOURCE_COPY??"on").toLowerCase()==="off"||keyframe===null||!(rawSeconds>0))return null;
  if(from-keyframe>10)return null;
  return rawBytes/rawSeconds*(to-keyframe)<=limit?{from:keyframe}:null;
}
export function sourceWords(segments,from,to) {
  const out=[];
  for(const seg of segments??[])for(const [s,e,t] of seg.words??[]){
    const text=String(t).replace(/[\r\n{}\\<>]/g,"").trim();
    if(text&&s>=from&&e<=to)out.push([Math.round((s-from)*100)/100,Math.round((e-from)*100)/100,text.slice(0,40)]);
  }
  return out;
}
// Per-second loudness (0-1, relative to the loudest second) and chat message counts across the source, for the
// editor's "why this moment" heat strip.
export function sourceSignals(energy,chat,from,to) {
  const a=Math.max(0,Math.floor(from)),b=Math.min(energy.length,Math.ceil(to));
  const e=energy.slice(a,b),peak=Math.max(1e-9,...e);
  return {energy:e.map(v=>Math.round(v/peak*100)/100),chat:Array.from({length:b-a},(_,i)=>chat[a+i]??0)};
}
// Turns a buffered recording window into a clip. Chooses the best `settings.duration` seconds inside
// [focusFrom, focusTo] (seconds into `raw`) from loudness plus per-second chat counts and snaps the edges to sentence
// boundaries. Then keeps an unframed *source* (the moment plus SOURCE_PAD seconds either side) with its transcript,
// and renders the vertical clip from it with `edit` (see edit.mjs), the same way the dashboard editor re-renders.
// Writes clip.mp4, source.mp4 and meta.json into `dir` and removes `raw` and intermediates.
// With `exact` (a moment picked by hand in a recording) the clip is exactly [focusFrom, focusTo]: no window search
// and no sentence snapping. `hint` (streamer name, stream title) helps Whisper spell them; `writer` (see writer.mjs)
// may write the hook and post caption from the clip's transcript, else the transcript-based ones are used.
// `findFacecam(sourcePath, signal)` (see facecam.py) finds the streamer's webcam overlay: it's kept with the source for
// the editor, and fills in the webcam box when the clip's look uses a facecam layout and has none yet.
// `rater(texts)` (rateMoments in writer.mjs) scores candidate moments by what was said in them, 0..10 each; with it and
// a transcript, the clip is the candidate that's best on loudness, chat and what was said together.
export async function processWindow(raw,{settings,text=null,style,focusFrom=0,focusTo=Infinity,chat=[],background=null,exact=false,hint="",writer=null,rater=null,findFacecam=null,messages=[],chatWeight=0.5,minRating=null},dir,signal) {
  const source=join(dir,"source.mp4"), energyFile=join(dir,"energy.json"), wordsFile=join(dir,"words.json");
  await mkdir(dir,{recursive:true});
  try {
    if(signal.aborted)throw new Error("Cancelled");
    // How long each step takes (seconds), returned as result.timings for the worker's log.
    const timings={};let lap=Date.now();const took=name=>{const now=Date.now();timings[name]=Math.round((now-lap)/100)/10;lap=now;};
    await command(python,[script("highlight.py"),raw,energyFile],{signal,timeout:120_000}).done;
    took("loudness");
    const {energy}=JSON.parse(await readFile(energyFile,"utf8"));
    let segments=[];
    // Transcription off (for this streamer, or the workspace): no Whisper, so no subtitles, no automatic hook and no
    // sentence-aligned cuts. `text` is the streamer's choices (see clipTextFor); without it, the workspace's.
    const transcribe=text?text.transcribe:settings.transcribe!==false, captions=text?text.subtitles:transcribe&&!!settings.captions;
    if(transcribe)try {
      // The kept-loaded transcriber (whisper.mjs) when it can, else a process of its own.
      await whisper(raw,wordsFile,{hint,python,signal,timeout:600_000});
      segments=JSON.parse(await readFile(wordsFile,"utf8")).segments;
    } catch(error) {
      // Sentence snapping is a refinement; only captions make the transcript mandatory.
      if(captions||signal.aborted)throw error;
    }
    const duration=settings.duration, total=energy.length;
    let start,end;
    if(exact){start=Math.max(0,focusFrom);end=Math.min(total,focusTo);if(end-start<15)throw new Error("That part of the recording is too short to clip");}
    else{
      // chatWeight: how much chat counts against loudness for this streamer, learned from views (0.5 even).
      const range={energy,chat,duration,from:Math.max(0,Math.floor(focusFrom)),to:Math.min(total,Math.ceil(focusTo)),chatWeight};
      const snap=s=>snapToSentences(s,s+duration,segments,{minLen:Math.max(15,duration-8),maxLen:Math.min(90,duration+8),total});
      const first=pickWindow(range);
      ({start,end}=snap(first));
      // Several spots that are good on loudness and chat, judged on what was said in them too.
      const candidates=rater&&segments.length&&!signal.aborted?candidateWindows(range).map(c=>({...c,...snap(c.start)})):[];
      if(candidates.length>1){
        const texts=candidates.map(c=>sourceWords(segments,c.start,c.end).map(w=>w[2]).join(" "));
        took("transcription");
        const ratings=await rater(texts).catch(()=>null);
        took("rating");
        // Nothing here worth a clip (every moment rated below minRating, e.g. a quiet stretch caught by the every-10-minutes
        // check): stop before encoding, writing and rendering. Without ratings (no AI) the clip is made as before.
        if(ratings&&minRating&&Math.max(...ratings)<minRating)throw Object.assign(new Error("nothing worth a clip (best moment rated "+Math.max(...ratings)+"/10)"),{skip:true});
        const pick=chooseMoment(candidates,ratings);
        if(ratings&&pick){({start,end}=pick);console.log("Moment ratings",ratings.join(", ")+": picked",candidates.indexOf(candidates.find(c=>c.start===pick.start))+1,"of",candidates.length);}
      }
    }
    let from=Math.max(0,start-SOURCE_PAD);const to=Math.min(total,end+SOURCE_PAD);
    // Copy the stream's own video when it's small enough, from the keyframe just before (a few seconds' more lead-in).
    const copy=copyPlan({rawBytes:(await stat(raw)).size,rawSeconds:total,from,to,keyframe:await keyframeAt(raw,from,signal)});
    if(copy)from=copy.from;
    if(timings.transcription===undefined)took("transcription");
    const words=sourceWords(segments,from,to);
    let base=null;
    try { if(style)base=normalizeStyle(style); } catch { /* an unreadable saved style falls back to the defaults */ }
    base??=defaultStyle({framing:settings.framing,captions});
    // The subtitles switch (the streamer's own, else the workspace's) always wins over a saved style.
    base.captions.on=captions;
    const initialEdit=defaultEdit(base,{trimStart:start-from,trimEnd:end-from});
    // Build the title before the first render; the saved edit and dashboard preview share it. The AI writer's hook
    // comes first when it has one; otherwise (or with AUTO_HOOKS=false off) the transcript-based one.
    const hooks=transcribe && (text?text.hook:true) && process.env.AUTO_HOOKS!=="false";
    // The AI writer only needs what was said, so it works while the source is encoded (the two longest steps).
    const said=words.filter(w=>w[0]>=initialEdit.trim.start-.05&&w[1]<=initialEdit.trim.end+.05).map(w=>w[2]).join(" ");
    const writing=writer&&!signal.aborted?writer({transcript:said,from,to:to}).catch(()=>null):Promise.resolve(null);
    // Frequent keyframes keep seeking in the editor responsive.
    if(copy)await command("ffmpeg",["-hide_banner","-loglevel","error","-y","-ss",String(from),"-i",raw,"-t",String(to-from),"-map","0:v:0","-map","0:a:0?","-c","copy","-movflags","+faststart",source],{signal,timeout:120_000}).done;
    else await command("ffmpeg",["-hide_banner","-loglevel","error","-y","-ss",String(from),"-i",raw,"-t",String(to-from),"-vf","scale=1280:1280:force_original_aspect_ratio=decrease:force_divisible_by=2","-c:v","libx264","-preset","veryfast","-crf","23","-maxrate","3000k","-bufsize","6000k","-g","30","-c:a","aac","-b:a","128k","-movflags","+faststart",source],{signal,timeout:encodeTimeout(to-from)}).done;
    took("source");
    const info=await videoInfo(source,signal);
    // "writing": how much longer the writer took than the encode.
    const ai=await writing;
    if(writer)took("writing");
    let withAi=initialEdit;
    if(hooks&&ai?.hook&&!initialEdit.hook.text?.trim()){
      const text=initialEdit.captions.mask?ai.hook.split(" ").map(maskWord).join(" "):ai.hook;
      const seconds=Math.min(initialEdit.trim.end-initialEdit.trim.start,Math.max(initialEdit.hook?.seconds??5,Math.ceil(text.split(/\s+/).length/3)));
      withAi={...initialEdit,hook:{...initialEdit.hook,text,seconds}};
    }
    let edit=applyAutomaticHook(withAi,words,{enabled:hooks});
    const face=findFacecam?await findFacecam(source,signal).catch(()=>null):null;
    // A stream filmed on a phone: keep where its picture is, and frame it as a phone stream instead of a small
    // picture on a blurred fill (or between black bars).
    const content=await findPhonePicture(source,info,signal);
    if(content)edit={...edit,frame:{...edit.frame,content:edit.frame.content??content,...((edit.frame.mode==="blur"||edit.frame.mode==="fit")&&{mode:"phone"})}};
    if(face&&(edit.frame.mode==="cam"||edit.frame.mode==="pip")&&!edit.frame.facecam?.box)edit={...edit,frame:{...edit.frame,facecam:{...edit.frame.facecam,box:face}}};
    // The background picked for this clip is kept in its edit, so re-renders and the editor use the same one.
    const bg=background?await background(edit):null;
    if(bg?.ref&&!edit.frame.background)edit={...edit,frame:{...edit.frame,background:bg.ref}};
    // The Twitch chat sent during the source ([seconds into it, name, text, colour]), kept for showing chat on the clip.
    const signals={...sourceSignals(energy,chat,from,to),messages:sourceMessages(messages,from,to)};
    took("framing");
    const rendered=await renderClip(source,{edit,words,width:info.width,height:info.height,background:bg,energy:signals.energy,messages:signals.messages},join(dir,"clip.mp4"),signal);
    const sourceBytes=await readFile(source);
    const meta={edit,words,...(ai?.caption&&{postCaption:ai.caption}),signals,source:{width:info.width,height:info.height,duration:Math.round((info.duration||to-from)*100)/100,face,content},sourceSha:clipHash(sourceBytes),sourceSize:sourceBytes.length};
    await writeFile(join(dir,"meta.json"),JSON.stringify(meta));
    took("render");
    return {...rendered,start,end,timings};
  } finally {
    for(const path of [raw,energyFile,wordsFile])await rm(path,{force:true});
  }
}
