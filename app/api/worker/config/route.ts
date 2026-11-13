import { database } from "../../../../db/raw";
import { defaults } from "../../../../lib/clipflow";
import { workerOwner } from "../../../../lib/worker-auth";
export const dynamic="force-dynamic";
export async function GET(request:Request){
 try{
  const db=database(),owner=await workerOwner(request,db);
  if(!owner)return Response.json({error:"Invalid worker token."},{status:401});
  const [s,p]=await Promise.all([db.prepare("SELECT id,url,status FROM streamers WHERE owner=? ORDER BY created_at").bind(owner).all(),db.prepare("SELECT duration,daily_limit,captions,framing,control FROM preferences WHERE owner=?").bind(owner).first(),db.prepare("UPDATE worker_tokens SET last_seen=? WHERE owner=?").bind(new Date().toISOString(),owner).run()]);
  return Response.json({control:p?.control??defaults.control,duration:p?.duration??defaults.duration,dailyLimit:p?.daily_limit??defaults.dailyLimit,captions:p?!!p.captions:defaults.captions,framing:p?.framing??defaults.framing,streamers:s.results},{headers:{"Cache-Control":"private, no-store"}});
 }catch(error){console.error("Worker config failed",error);return Response.json({error:"Config unavailable."},{status:503});}
}
