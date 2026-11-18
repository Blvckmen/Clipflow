import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { command } from "./process.mjs";
import { fileURLToPath } from "node:url";
import { channelUrl, clipHash, probeResult } from "./core.mjs";
import { pickWindow, snapToSentences } from "./highlights.mjs";
import { defaultEdit, defaultStyle, maskWord, normalizeStyle } from "./edit.mjs";
import { encodeTimeout, renderClip, videoInfo } from "./render.mjs";
import { applyAutomaticHook } from "./hooks.mjs";
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
export async function processWindow(raw,{settings,style,focusFrom=0,focusTo=Infinity,chat=[],background=null,exact=false,hint="",writer=null,findFacecam=null},dir,signal) {
  const source=join(dir,"source.mp4"), energyFile=join(dir,"energy.json"), wordsFile=join(dir,"words.json");
  await mkdir(dir,{recursive:true});
  try {
    if(signal.aborted)throw new Error("Cancelled");
    await command(python,[script("highlight.py"),raw,energyFile],{signal,timeout:120_000}).done;
    const {energy}=JSON.parse(await readFile(energyFile,"utf8"));
    let segments=[];
    // Transcription off (a workspace setting): no Whisper, so no subtitles and no sentence-aligned cuts.
    const transcribe=settings.transcribe!==false, captions=transcribe&&!!settings.captions;
    if(transcribe)try {
      await command(python,[script("captions.py"),"words",raw,wordsFile,String(hint).slice(0,200)],{signal,timeout:600_000}).done;
      segments=JSON.parse(await readFile(wordsFile,"utf8")).segments;
    } catch(error) {
      // Sentence snapping is a refinement; only captions make the transcript mandatory.
      if(captions||signal.aborted)throw error;
    }
    const duration=settings.duration, total=energy.length;
    let start,end;
    if(exact){start=Math.max(0,focusFrom);end=Math.min(total,focusTo);if(end-start<15)throw new Error("That part of the recording is too short to clip");}
    else{
      const first=pickWindow({energy,chat,duration,from:Math.max(0,Math.floor(focusFrom)),to:Math.min(total,Math.ceil(focusTo))});
      ({start,end}=snapToSentences(first,first+duration,segments,{minLen:Math.max(15,duration-8),maxLen:Math.min(90,duration+8),total}));
    }
    const from=Math.max(0,start-SOURCE_PAD), to=Math.min(total,end+SOURCE_PAD);
    // Frequent keyframes keep seeking in the editor responsive.
    await command("ffmpeg",["-hide_banner","-loglevel","error","-y","-ss",String(from),"-i",raw,"-t",String(to-from),"-vf","scale=1280:1280:force_original_aspect_ratio=decrease:force_divisible_by=2","-c:v","libx264","-preset","veryfast","-crf","23","-maxrate","3000k","-bufsize","6000k","-g","30","-c:a","aac","-b:a","128k","-movflags","+faststart",source],{signal,timeout:encodeTimeout(to-from)}).done;
    const info=await videoInfo(source,signal);
    const words=sourceWords(segments,from,to);
    let base=null;
    try { if(style)base=normalizeStyle(style); } catch { /* an unreadable saved style falls back to the defaults */ }
    base??=defaultStyle({framing:settings.framing,captions});
    // The workspace's on/off switch for captions always wins over a saved style.
    base.captions.on=captions;
    const initialEdit=defaultEdit(base,{trimStart:start-from,trimEnd:end-from});
    // Build the title before the first render; the saved edit and dashboard preview share it. The AI writer's hook
    // comes first when it has one; otherwise (or with AUTO_HOOKS=false off) the transcript-based one.
    const hooks=transcribe && process.env.AUTO_HOOKS!=="false";
    let ai=null;
    if(writer&&!signal.aborted){
      const said=words.filter(w=>w[0]>=initialEdit.trim.start-.05&&w[1]<=initialEdit.trim.end+.05).map(w=>w[2]).join(" ");
      ai=await writer({transcript:said,from,to:to}).catch(()=>null);
    }
    let withAi=initialEdit;
    if(hooks&&ai?.hook&&!initialEdit.hook.text?.trim()){
      const text=initialEdit.captions.mask?ai.hook.split(" ").map(maskWord).join(" "):ai.hook;
      const seconds=Math.min(initialEdit.trim.end-initialEdit.trim.start,Math.max(initialEdit.hook?.seconds??5,Math.ceil(text.split(/s+/).length/3)));
      withAi={...initialEdit,hook:{...initialEdit.hook,text,seconds}};
    }
    let edit=applyAutomaticHook(withAi,words,{enabled:hooks});
    const face=findFacecam?await findFacecam(source,signal).catch(()=>null):null;
    if(face&&(edit.frame.mode==="cam"||edit.frame.mode==="pip")&&!edit.frame.facecam?.box)edit={...edit,frame:{...edit.frame,facecam:{...edit.frame.facecam,box:face}}};
    // The background picked for this clip is kept in its edit, so re-renders and the editor use the same one.
    const bg=background?await background(edit):null;
    if(bg?.ref&&!edit.frame.background)edit={...edit,frame:{...edit.frame,background:bg.ref}};
    const rendered=await renderClip(source,{edit,words,width:info.width,height:info.height,background:bg},join(dir,"clip.mp4"),signal);
    const sourceBytes=await readFile(source);
    const meta={edit,words,...(ai?.caption&&{postCaption:ai.caption}),signals:sourceSignals(energy,chat,from,to),source:{width:info.width,height:info.height,duration:Math.round((info.duration||to-from)*100)/100,face},sourceSha:clipHash(sourceBytes),sourceSize:sourceBytes.length};
    await writeFile(join(dir,"meta.json"),JSON.stringify(meta));
    return {...rendered,start,end};
  } finally {
    for(const path of [raw,energyFile,wordsFile])await rm(path,{force:true});
  }
}
