import { z } from "zod";
import { database } from "../../../../db/raw";
import { workerOwner } from "../../../../lib/worker-auth";
const clipSchema=z.object({id:z.string().uuid(),streamerId:z.string().uuid(),createdAt:z.string().datetime(),duration:z.number().int().min(15).max(90),captions:z.boolean(),sha:z.string().regex(/^[0-9a-f]{64}$/),size:z.number().int().min(1024).max(32*1024*1024)});
export async function POST(request:Request){
 try{
  const db=database(),owner=await workerOwner(request,db);
  if(!owner)return Response.json({error:"Invalid worker token."},{status:401});
  let clip;try{clip=clipSchema.parse(await request.json());}catch{return Response.json({error:"Invalid clip report."},{status:400});}
  const streamer=await db.prepare("SELECT name FROM streamers WHERE id=? AND owner=?").bind(clip.streamerId,owner).first<{name:string}>();
  if(!streamer)return Response.json({error:"Streamer not found."},{status:404});
  // Reports are retried by the worker, so a repeated id is acknowledged without a second log entry.
  const existing=await db.prepare("SELECT owner FROM clips WHERE id=?").bind(clip.id).first<{owner:string}>();
  if(existing)return existing.owner===owner?Response.json({ok:true,duplicate:true}):Response.json({error:"Clip id conflict."},{status:409});
  await db.batch([
   db.prepare("INSERT INTO clips (id,owner,streamer_id,created_at,duration,captions,sha,size) VALUES (?,?,?,?,?,?,?,?)").bind(clip.id,owner,clip.streamerId,clip.createdAt,clip.duration,Number(clip.captions),clip.sha,clip.size),
   db.prepare("INSERT INTO events (id,owner,message,created_at) VALUES (?,?,?,?)").bind(crypto.randomUUID(),owner,"Worker captured a "+clip.duration+"s clip from "+streamer.name+".",new Date().toISOString()),
  ]);
  return Response.json({ok:true});
 }catch(error){console.error("Clip report failed",error);return Response.json({error:"Clip report not saved."},{status:503});}
}
