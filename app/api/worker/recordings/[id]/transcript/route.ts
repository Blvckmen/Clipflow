import { z } from "zod";
import { bucket, database, transcriptKey } from "../../../../../../db/raw";
import { workerOwner } from "../../../../../../lib/worker-auth";
// The worker's transcript of a whole recording, for searching what was said: {lines: [[start, end, text], ...]} in
// seconds. Stored in R2 (a long stream's transcript is too big for a database row); transcript_at marks it ready.
const MAX_BYTES=8*1024*1024;
const body=z.object({lines:z.array(z.tuple([z.number().min(0).max(200_000),z.number().min(0).max(200_000),z.string().max(1000)])).max(100_000)});
export async function PUT(request:Request,{params}:{params:Promise<{id:string}>}){
 try{
  const db=database(),owner=await workerOwner(request,db);
  if(!owner)return Response.json({error:"Invalid worker token."},{status:401});
  const store=bucket();
  if(!store)return Response.json({error:"Clip storage is not enabled."},{status:501});
  const {id}=await params;
  const row=/^[0-9a-f-]{36}$/i.test(id)?await db.prepare("SELECT id FROM recordings WHERE id=? AND owner=?").bind(id,owner).first():null;
  if(!row)return Response.json({error:"Recording not found."},{status:404});
  if(Number(request.headers.get("content-length"))>MAX_BYTES)return Response.json({error:"Transcript too large."},{status:413});
  let parsed;try{parsed=body.parse(await request.json());}catch{return Response.json({error:"Invalid transcript."},{status:400});}
  const lines=parsed.lines.map(([s,e,t])=>[Math.round(s*10)/10,Math.round(e*10)/10,t.replace(/\s+/g," ").trim()] as const).filter(l=>l[2]);
  await store.put(transcriptKey(id),JSON.stringify({lines}),{httpMetadata:{contentType:"application/json"}});
  await db.prepare("UPDATE recordings SET transcript_at=? WHERE id=? AND owner=?").bind(new Date().toISOString(),id,owner).run();
  return Response.json({ok:true,lines:lines.length});
 }catch(error){console.error("Transcript upload failed",error);return Response.json({error:"Transcript not saved."},{status:503});}
}
