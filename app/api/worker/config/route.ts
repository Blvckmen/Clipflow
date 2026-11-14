import { database } from "../../../../db/raw";
import { defaults } from "../../../../lib/clipflow";
import { workerOwner } from "../../../../lib/worker-auth";
export const dynamic="force-dynamic";
const parse=(json:unknown)=>{try{return typeof json==="string"?JSON.parse(json):null;}catch{return null;}};
export async function GET(request:Request){
 try{
  const db=database(),owner=await workerOwner(request,db);
  if(!owner)return Response.json({error:"Invalid worker token."},{status:401});
  const [s,p,r]=await Promise.all([
   db.prepare("SELECT id,url,status,style FROM streamers WHERE owner=? ORDER BY created_at").bind(owner).all<{id:string;url:string;status:string;style:string|null}>(),
   db.prepare("SELECT duration,daily_limit,captions,framing,control,style FROM preferences WHERE owner=?").bind(owner).first(),
   // Edits saved in the dashboard that still need rendering, oldest request first.
   db.prepare("SELECT id,edit,edit_rev,transcript,source_meta FROM clips WHERE owner=? AND render_state='queued' AND edit IS NOT NULL ORDER BY coalesce(rendered_at,created_at) LIMIT 5").bind(owner).all<{id:string;edit:string;edit_rev:number;transcript:string|null;source_meta:string|null}>(),
   db.prepare("UPDATE worker_tokens SET last_seen=? WHERE owner=?").bind(new Date().toISOString(),owner).run(),
  ]);
  return Response.json({
   control:p?.control??defaults.control,duration:p?.duration??defaults.duration,dailyLimit:p?.daily_limit??defaults.dailyLimit,captions:p?!!p.captions:defaults.captions,framing:p?.framing??defaults.framing,
   style:parse(p?.style),
   streamers:s.results.map(x=>({id:x.id,url:x.url,status:x.status,style:parse(x.style)})),
   renders:r.results.map(x=>({id:x.id,rev:x.edit_rev,edit:parse(x.edit),words:parse(x.transcript)??[],source:parse(x.source_meta)})).filter(x=>x.edit),
  },{headers:{"Cache-Control":"private, no-store"}});
 }catch(error){console.error("Worker config failed",error);return Response.json({error:"Config unavailable."},{status:503});}
}
