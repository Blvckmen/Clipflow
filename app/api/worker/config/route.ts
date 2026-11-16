import { database } from "../../../../db/raw";
import { defaults } from "../../../../lib/clipflow";
import { workerOwner } from "../../../../lib/worker-auth";
export const dynamic="force-dynamic";
const parse=(json:unknown)=>{try{return typeof json==="string"?JSON.parse(json):null;}catch{return null;}};
export async function GET(request:Request){
 try{
  const db=database(),owner=await workerOwner(request,db);
  if(!owner)return Response.json({error:"Invalid worker token."},{status:401});
  const [s,p,r,,b,rec,req]=await Promise.all([
   db.prepare("SELECT id,url,status,style,capture_mode FROM streamers WHERE owner=? ORDER BY created_at").bind(owner).all<{id:string;url:string;status:string;style:string|null;capture_mode:string|null}>(),
   db.prepare("SELECT duration,daily_limit,captions,framing,control,style,transcribe,recording_days FROM preferences WHERE owner=?").bind(owner).first(),
   // Edits saved in the dashboard that still need rendering, oldest request first.
   db.prepare("SELECT id,edit,edit_rev,transcript,source_meta FROM clips WHERE owner=? AND render_state='queued' AND edit IS NOT NULL ORDER BY coalesce(rendered_at,created_at) LIMIT 5").bind(owner).all<{id:string;edit:string;edit_rev:number;transcript:string|null;source_meta:string|null}>(),
   db.prepare("UPDATE worker_tokens SET last_seen=? WHERE owner=?").bind(new Date().toISOString(),owner).run(),
   // Split-screen background videos the worker may download (GET /api/worker/backgrounds/<id>).
   db.prepare("SELECT id,size,duration FROM backgrounds WHERE owner=? ORDER BY created_at").bind(owner).all<{id:string;size:number;duration:number|null}>(),
   // Recordings the dashboard still has (the worker deletes its copies of the rest) and clips asked for from them.
   db.prepare("SELECT id FROM recordings WHERE owner=? ORDER BY started_at DESC LIMIT 2000").bind(owner).all<{id:string}>(),
   db.prepare("SELECT id,recording_id,kind,start,end,count FROM recording_requests WHERE owner=? AND state IN ('queued','working') ORDER BY created_at LIMIT 50").bind(owner).all<{id:string;recording_id:string;kind:string;start:number|null;end:number|null;count:number|null}>(),
  ]);
  return Response.json({
   control:p?.control??defaults.control,duration:p?.duration??defaults.duration,dailyLimit:p?.daily_limit??defaults.dailyLimit,captions:p?!!p.captions:defaults.captions,transcribe:p?!!p.transcribe:defaults.transcribe,framing:p?.framing??defaults.framing,
   style:parse(p?.style),
   streamers:s.results.map(x=>({id:x.id,url:x.url,status:x.status,style:parse(x.style),captureMode:x.capture_mode??"clip"})),
   recordingDays:(p?.recording_days as number|undefined)??defaults.recordingDays,recordings:rec.results.map(x=>x.id),
   clipRequests:req.results.map(x=>x.kind==="moment"?{id:x.id,recordingId:x.recording_id,kind:x.kind,start:x.start,end:x.end}:{id:x.id,recordingId:x.recording_id,kind:x.kind,count:x.count}),
   backgrounds:b.results,
   renders:r.results.map(x=>({id:x.id,rev:x.edit_rev,edit:parse(x.edit),words:parse(x.transcript)??[],source:parse(x.source_meta)})).filter(x=>x.edit),
  },{headers:{"Cache-Control":"private, no-store"}});
 }catch(error){console.error("Worker config failed",error);return Response.json({error:"Config unavailable."},{status:503});}
}
