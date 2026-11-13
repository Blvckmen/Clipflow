import { z } from "zod";
import { database } from "../../../../db/raw";
import { workerOwner } from "../../../../lib/worker-auth";
const statusSchema=z.object({
 streamers:z.array(z.object({id:z.string().uuid(),status:z.enum(["live","recording","offline","error"]),checkedAt:z.string().datetime(),title:z.string().max(200).nullish()})).max(500),
 // The worker's latest problem, e.g. a failed render or a refused upload.
 error:z.object({message:z.string().min(1).max(500),at:z.string().datetime()}).optional(),
});
export async function POST(request:Request){
 try{
  const db=database(),owner=await workerOwner(request,db);
  if(!owner)return Response.json({error:"Invalid worker token."},{status:401});
  let body;try{body=statusSchema.parse(await request.json());}catch{return Response.json({error:"Invalid status report."},{status:400});}
  // The owner predicate means ids belonging to someone else are silently ignored.
  const statements=body.streamers.map(s=>db.prepare("UPDATE streamers SET live_status=?,live_checked_at=?,live_title=? WHERE id=? AND owner=?").bind(s.status,s.checkedAt,s.title??null,s.id,owner));
  if(body.error)statements.push(db.prepare("UPDATE worker_tokens SET last_error=?,last_error_at=? WHERE owner=?").bind(body.error.message,body.error.at,owner));
  if(statements.length)await db.batch(statements);
  return Response.json({ok:true,updated:body.streamers.length});
 }catch(error){console.error("Status report failed",error);return Response.json({error:"Status not saved."},{status:503});}
}
