import { z } from "zod";
import { database } from "../../../../db/raw";
import { workerOwner } from "../../../../lib/worker-auth";
const statusSchema=z.object({streamers:z.array(z.object({id:z.string().uuid(),status:z.enum(["live","recording","offline","error"]),checkedAt:z.string().datetime(),title:z.string().max(200).nullish()})).max(500)});
export async function POST(request:Request){
 try{
  const db=database(),owner=await workerOwner(request,db);
  if(!owner)return Response.json({error:"Invalid worker token."},{status:401});
  let body;try{body=statusSchema.parse(await request.json());}catch{return Response.json({error:"Invalid status report."},{status:400});}
  if(!body.streamers.length)return Response.json({ok:true,updated:0});
  // The owner predicate means ids belonging to someone else are silently ignored.
  await db.batch(body.streamers.map(s=>db.prepare("UPDATE streamers SET live_status=?,live_checked_at=?,live_title=? WHERE id=? AND owner=?").bind(s.status,s.checkedAt,s.title??null,s.id,owner)));
  return Response.json({ok:true,updated:body.streamers.length});
 }catch(error){console.error("Status report failed",error);return Response.json({error:"Status not saved."},{status:503});}
}
