import { database } from "../../../../db/raw";
import { defaults } from "../../../../lib/clipflow";
import { workerOwner } from "../../../../lib/worker-auth";
export const dynamic="force-dynamic";
const parse=(json:unknown)=>{try{return typeof json==="string"?JSON.parse(json):null;}catch{return null;}};
// A streamer's own transcription, subtitles and hook choices (only true/false values; anything else follows the workspace).
const clipText=(json:string|null)=>{const v=parse(json);return v&&typeof v==="object"?Object.fromEntries(["transcribe","subtitles","hook"].filter(k=>typeof v[k]==="boolean").map(k=>[k,v[k]])):{};};
export async function GET(request:Request){
 try{
  const db=database(),owner=await workerOwner(request,db);
  if(!owner)return Response.json({error:"Invalid worker token."},{status:401});
  const [s,p,r,,b,rec,req]=await Promise.all([
   db.prepare("SELECT id,url,status,style,capture_mode,clip_text FROM streamers WHERE owner=? ORDER BY created_at").bind(owner).all<{id:string;url:string;status:string;style:string|null;capture_mode:string|null;clip_text:string|null}>(),
   db.prepare("SELECT duration,daily_limit,captions,framing,control,style,transcribe,recording_days,import_clips FROM preferences WHERE owner=?").bind(owner).first(),
   // Edits saved in the dashboard that still need rendering, oldest request first.
   // signals: the source's loudness, for jump cuts and punch-in zooms.
   db.prepare("SELECT id,edit,edit_rev,transcript,source_meta,signals FROM clips WHERE owner=? AND render_state='queued' AND edit IS NOT NULL ORDER BY coalesce(rendered_at,created_at) LIMIT 5").bind(owner).all<{id:string;edit:string;edit_rev:number;transcript:string|null;source_meta:string|null;signals:string|null}>(),
   db.prepare("UPDATE worker_tokens SET last_seen=? WHERE owner=?").bind(new Date().toISOString(),owner).run(),
   // Split-screen background videos the worker may download (GET /api/worker/backgrounds/<id>).
   db.prepare("SELECT id,name,size,duration,content_type FROM backgrounds WHERE owner=? ORDER BY created_at").bind(owner).all<{id:string;name:string;size:number;duration:number|null;content_type:string}>(),
   // Recordings the dashboard still has (the worker deletes its copies of the rest) and clips asked for from them.
   db.prepare("SELECT id FROM recordings WHERE owner=? ORDER BY started_at DESC LIMIT 2000").bind(owner).all<{id:string}>(),
   db.prepare("SELECT id,recording_id,kind,start,end,count FROM recording_requests WHERE owner=? AND state IN ('queued','working') ORDER BY created_at LIMIT 50").bind(owner).all<{id:string;recording_id:string;kind:string;start:number|null;end:number|null;count:number|null}>(),
  ]);
  return Response.json({
   control:p?.control??defaults.control,duration:p?.duration??defaults.duration,dailyLimit:p?.daily_limit??defaults.dailyLimit,captions:p?!!p.captions:defaults.captions,transcribe:p?!!p.transcribe:defaults.transcribe,framing:p?.framing??defaults.framing,
   style:parse(p?.style),
   streamers:s.results.map(x=>({id:x.id,url:x.url,status:x.status,style:parse(x.style),captureMode:x.capture_mode??"clip",text:clipText(x.clip_text)})),
   recordingDays:(p?.recording_days as number|undefined)??defaults.recordingDays,importClips:(p?.import_clips as number|undefined)??defaults.importClips,recordings:rec.results.map(x=>x.id),
   clipRequests:req.results.map(x=>x.kind==="moment"?{id:x.id,recordingId:x.recording_id,kind:x.kind,start:x.start,end:x.end}:{id:x.id,recordingId:x.recording_id,kind:x.kind,count:x.count}),
   // kind: a looping video, or a still image (rendered for the clip's whole length).
   backgrounds:b.results.map(({content_type,...x})=>({...x,kind:content_type.startsWith("image/")?"image":"video",type:content_type})),
   renders:r.results.map(x=>({id:x.id,rev:x.edit_rev,edit:parse(x.edit),words:parse(x.transcript)??[],source:parse(x.source_meta),signals:parse(x.signals)})).filter(x=>x.edit),
  },{headers:{"Cache-Control":"private, no-store"}});
 }catch(error){console.error("Worker config failed",error);return Response.json({error:"Config unavailable."},{status:503});}
}
