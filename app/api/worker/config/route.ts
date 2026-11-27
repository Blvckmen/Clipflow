import { env } from "cloudflare:workers";
import { database } from "../../../../db/raw";
import { defaults, readWorkerSettings, workerSettingsRev } from "../../../../lib/clipflow";
import { workerOwner } from "../../../../lib/worker-auth";
import { automationAllowed } from "../../../../lib/billing";
import { readStreamerViewerClips, readViewerClips } from "../../../../lib/viewer-clips.mjs";
export const dynamic="force-dynamic";
const parse=(json:unknown)=>{try{return typeof json==="string"?JSON.parse(json):null;}catch{return null;}};
// A streamer's own transcription, subtitles and hook choices (only true/false values; anything else follows the workspace).
const clipText=(json:string|null)=>{const v=parse(json);return v&&typeof v==="object"?Object.fromEntries(["transcribe","subtitles","hook"].filter(k=>typeof v[k]==="boolean").map(k=>[k,v[k]])):{};};
// What was learned from this streamer's posts (lib/insights.mjs), unless the owner turned learning off.
const chatWeightOf=(learned:string|null,learn:unknown)=>{if(learn===0||learned==null)return {};const w=(parse(learned) as {chatWeight?:unknown}|null)?.chatWeight;return typeof w==="number"&&w>=0.2&&w<=0.8?{chatWeight:w}:{};};
export async function GET(request:Request){
 try{
  const db=database(),owner=await workerOwner(request,db);
  if(!owner)return Response.json({error:"Invalid worker token."},{status:401});
  const [s,p,r,wt,b,rec,req,tr,hl,vc,ry]=await Promise.all([
   db.prepare("SELECT id,url,status,style,capture_mode,clip_text,learned,viewer_clips,daily_limit FROM streamers WHERE owner=? ORDER BY priority IS NULL,priority,created_at").bind(owner).all<{id:string;url:string;status:string;style:string|null;capture_mode:string|null;clip_text:string|null;learned:string|null;viewer_clips:string|null;daily_limit:number|null}>(),
   db.prepare("SELECT duration,daily_limit,captions,framing,control,style,transcribe,recording_days,import_clips,viewer_clips,clip_command,learn,worker_settings FROM preferences WHERE owner=?").bind(owner).first(),
   // Edits saved in the dashboard that still need rendering, oldest request first.
   // signals: the source's loudness, for jump cuts and punch-in zooms.
   db.prepare("SELECT id,edit,edit_rev,transcript,source_meta,signals FROM clips WHERE owner=? AND render_state='queued' AND edit IS NOT NULL ORDER BY coalesce(rendered_at,created_at) LIMIT 5").bind(owner).all<{id:string;edit:string;edit_rev:number;transcript:string|null;source_meta:string|null;signals:string|null}>(),
   // Checking in; restart_at: a restart asked for from Settings → This PC, done by the worker once it is idle.
   db.prepare("UPDATE worker_tokens SET last_seen=? WHERE owner=? RETURNING restart_at").bind(new Date().toISOString(),owner).first<{restart_at:string|null}>(),
   // Split-screen background videos the worker may download (GET /api/worker/backgrounds/<id>).
   db.prepare("SELECT id,name,size,duration,content_type FROM backgrounds WHERE owner=? ORDER BY created_at").bind(owner).all<{id:string;name:string;size:number;duration:number|null;content_type:string}>(),
   // Recordings the dashboard still has (the worker deletes its copies of the rest), videos waiting to be imported
   // (read in the same pass), and clips asked for from them.
   db.prepare("SELECT id,streamer_id,state,source_url FROM recordings WHERE owner=? ORDER BY started_at DESC LIMIT 2000").bind(owner).all<{id:string;streamer_id:string;state:string;source_url:string|null}>(),
   db.prepare("SELECT id,recording_id,kind,start,end,count FROM recording_requests WHERE owner=? AND state IN ('queued','working') ORDER BY created_at LIMIT 50").bind(owner).all<{id:string;recording_id:string;kind:string;start:number|null;end:number|null;count:number|null}>(),
   db.prepare("SELECT t.clip_id,t.lang,t.rev,t.source_caption,c.edit,c.transcript,c.source_meta,c.signals,s.name AS streamer FROM clip_translations t INDEXED BY clip_translations_owner_state JOIN clips c ON c.id=t.clip_id LEFT JOIN streamers s ON s.id=c.streamer_id WHERE t.owner=? AND t.state='queued' AND c.edit IS NOT NULL ORDER BY t.created_at LIMIT 3").bind(owner).all<{clip_id:string;lang:string;rev:number;source_caption:string|null;edit:string;transcript:string|null;source_meta:string|null;signals:string|null;streamer:string|null}>(),
   // Highlight videos to make (lib/highlights.ts).
   db.prepare("SELECT id,clips FROM highlights INDEXED BY highlights_owner_state WHERE owner=? AND state='queued' ORDER BY created_at LIMIT 2").bind(owner).all<{id:string;clips:string}>(),
   // Viewers' Twitch clips picked in the dashboard ("ask me first") for the worker to make.
   db.prepare("SELECT clip_id,streamer_id,title,duration,views,clip_created_at,video_id,vod_offset FROM viewer_clip_candidates INDEXED BY viewer_clip_candidates_owner_state WHERE owner=? AND state='wanted' ORDER BY updated_at LIMIT 10").bind(owner).all<{clip_id:string;streamer_id:string;title:string;duration:number;views:number;clip_created_at:string;video_id:string|null;vod_offset:number|null}>(),
   // Failed clips asked to be made again in the last hour (Being made → Try again); the worker acts on each once.
   db.prepare("SELECT clip_id FROM clip_retries WHERE owner=? AND requested_at>? ORDER BY requested_at LIMIT 50").bind(owner,new Date(Date.now()-3600_000).toISOString()).all<{clip_id:string}>(),
  ]);
  // A workspace whose trial or plan has ended reads as paused (nothing recorded or made, what's queued kept) until a
  // plan is chosen. Only with billing on, and a failed check runs as usual (lib/billing.ts).
  const control=p?.control??defaults.control,running=control==="running"&&!await automationAllowed(env,db,owner)?"paused":control;
  // streamers is in recording-priority order: the worker gives full capture slots to the first live ones.
  return Response.json({
   control:running,duration:p?.duration??defaults.duration,dailyLimit:p?.daily_limit??defaults.dailyLimit,captions:p?!!p.captions:defaults.captions,transcribe:p?!!p.transcribe:defaults.transcribe,framing:p?.framing??defaults.framing,
   style:parse(p?.style),
   // Settings → This PC; each choice left out follows the worker's .env (worker/core.mjs workerTuning).
   // workerRev: their fingerprint, which the worker reports back once it runs with them (Saved → Applied).
   restartAt:wt?.restart_at??null,
   retries:ry.results.map(x=>x.clip_id),
   // Whether this site lends its Twitch app to workers without one (app/api/worker/twitch).
   twitchApp:!!((env as {TWITCH_CLIENT_ID?:string}).TWITCH_CLIENT_ID&&(env as {TWITCH_CLIENT_SECRET?:string}).TWITCH_CLIENT_SECRET),
   worker:readWorkerSettings(p?.worker_settings),workerRev:workerSettingsRev(readWorkerSettings(p?.worker_settings)),
   streamers:s.results.map(x=>({id:x.id,url:x.url,status:x.status,style:parse(x.style),captureMode:x.capture_mode??"clip",text:clipText(x.clip_text),viewerClips:readStreamerViewerClips(x.viewer_clips),dailyLimit:x.daily_limit??null,...chatWeightOf(x.learned,p?.learn)})),
   recordingDays:(p?.recording_days as number|undefined)??defaults.recordingDays,importClips:(p?.import_clips as number|undefined)??defaults.importClips,viewerClips:readViewerClips(p?.viewer_clips),
   viewerClipPicks:vc.results.map(x=>({id:x.clip_id,streamerId:x.streamer_id,title:x.title,duration:x.duration,views:x.views,createdAt:x.clip_created_at,videoId:x.video_id,vodOffset:x.vod_offset})),clipCommand:(p?.clip_command as string|undefined)??defaults.clipCommand,recordings:rec.results.map(x=>x.id),
   // Oldest first, so the worker downloads them in the order they were pasted.
   uploads:rec.results.filter(x=>x.source_url==="upload:"+x.id&&(x.state==="queued"||x.state==="importing")).reverse().slice(0,20).map(x=>({id:x.id,streamerId:x.streamer_id})),
   imports:rec.results.filter(x=>x.source_url&&!x.source_url.startsWith("upload:")&&(x.state==="queued"||x.state==="importing")).reverse().slice(0,20).map(x=>({id:x.id,streamerId:x.streamer_id,url:x.source_url})),
   clipRequests:req.results.map(x=>x.kind==="moment"?{id:x.id,recordingId:x.recording_id,kind:x.kind,start:x.start,end:x.end}:{id:x.id,recordingId:x.recording_id,kind:x.kind,count:x.count}),
   // kind: a looping video, or a still image (rendered for the clip's whole length).
   backgrounds:b.results.map(({content_type,...x})=>({...x,kind:content_type.startsWith("image/")?"image":"video",type:content_type})),
   // Clips to translate for accounts that post in another language (lib/languages.ts): like renders, plus the caption.
   highlights:hl.results.map(x=>({id:x.id,clips:parse(x.clips)??[]})),
   translations:tr.results.map(x=>({id:x.clip_id,lang:x.lang,rev:x.rev,caption:x.source_caption,streamer:x.streamer,edit:parse(x.edit),words:parse(x.transcript)??[],source:parse(x.source_meta),signals:parse(x.signals)})).filter(x=>x.edit),
   renders:r.results.map(x=>({id:x.id,rev:x.edit_rev,edit:parse(x.edit),words:parse(x.transcript)??[],source:parse(x.source_meta),signals:parse(x.signals)})).filter(x=>x.edit),
  },{headers:{"Cache-Control":"private, no-store"}});
 }catch(error){console.error("Worker config failed",error);return Response.json({error:"Config unavailable."},{status:503});}
}
