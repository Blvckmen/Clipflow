import { z } from "zod";
import { database } from "../../../../db/raw";
import { workerOwner } from "../../../../lib/worker-auth";
import { defaults } from "../../../../lib/clipflow";
const id=z.string().uuid(),iso=z.string().datetime();
// The worker reports a recording's whole known state each time (it retries until one gets through), and each clip
// request it takes on.
const bodySchema=z.discriminatedUnion("op",[
 z.object({op:z.literal("recording"),id,streamerId:id,startedAt:iso,endedAt:iso.nullish(),title:z.string().max(200).nullish(),
  state:z.enum(["recording","importing","processing","ready","failed"]),imported:z.boolean().optional(),duration:z.number().int().min(0).max(7*86400).nullish(),size:z.number().int().min(0).nullish(),
  signals:z.object({step:z.number().int().min(1).max(3600),energy:z.array(z.number().min(0).max(1)).max(2100),chat:z.array(z.number().int().min(0)).max(2100)}).nullish(),
  error:z.string().max(300).nullish()}),
 z.object({op:z.literal("request"),id,state:z.enum(["working","done","failed"]),clips:z.number().int().min(0).max(50).optional(),error:z.string().max(300).optional()}),
]);
export async function POST(request:Request){
 try{
  const db=database(),owner=await workerOwner(request,db);
  if(!owner)return Response.json({error:"Invalid worker token."},{status:401});
  let body;try{body=bodySchema.parse(await request.json());}catch{return Response.json({error:"Invalid recording report."},{status:400});}
  const now=new Date().toISOString();
  if(body.op==="request"){
   await db.prepare("UPDATE recording_requests SET state=?,clips=coalesce(?,clips),error=?,updated_at=? WHERE id=? AND owner=?").bind(body.state,body.clips??null,body.error??null,now,body.id,owner).run();
   return Response.json({ok:true});
  }
  const streamer=await db.prepare("SELECT name FROM streamers WHERE id=? AND owner=?").bind(body.streamerId,owner).first<{name:string}>();
  if(!streamer)return Response.json({error:"Streamer not found."},{status:404});
  const existing=await db.prepare("SELECT owner,state,source_url FROM recordings WHERE id=?").bind(body.id).first<{owner:string;state:string;source_url:string|null}>();
  if(existing&&existing.owner!==owner)return Response.json({error:"Recording id conflict."},{status:409});
  // An imported video's row is made by the dashboard; once deleted there, the worker's reports don't bring it back.
  if(!existing&&body.imported)return Response.json({error:"Recording not found."},{status:404});
  const signals=body.signals?JSON.stringify(body.signals):null,statements:D1PreparedStatement[]=[];
  if(!existing){
   const days=(await db.prepare("SELECT recording_days FROM preferences WHERE owner=?").bind(owner).first<{recording_days:number}>())?.recording_days??defaults.recordingDays;
   const expires=new Date(Date.parse(body.startedAt)+days*86_400_000).toISOString();
   statements.push(db.prepare("INSERT INTO recordings (id,owner,streamer_id,title,started_at,ended_at,duration,size,state,error,signals,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .bind(body.id,owner,body.streamerId,body.title??null,body.startedAt,body.endedAt??null,body.duration??null,body.size??null,body.state,body.error??null,signals,expires,now));
   if(body.state==="recording")statements.push(db.prepare("INSERT INTO events (id,owner,message,created_at) VALUES (?,?,?,?)").bind(crypto.randomUUID(),owner,"Recording "+streamer.name+"'s whole stream.",now));
  }else{
   statements.push(db.prepare("UPDATE recordings SET title=coalesce(?,title),ended_at=coalesce(?,ended_at),duration=coalesce(?,duration),size=coalesce(?,size),state=?,error=?,signals=coalesce(?,signals) WHERE id=? AND owner=?")
    .bind(body.title??null,body.endedAt??null,body.duration??null,body.size??null,body.state,body.error??null,signals,body.id,owner));
   if(body.state==="ready"&&existing.state!=="ready")statements.push(db.prepare("INSERT INTO events (id,owner,message,created_at) VALUES (?,?,?,?)").bind(crypto.randomUUID(),owner,(existing.source_url?"Imported a ":"Saved a ")+Math.max(1,Math.round((body.duration??0)/60))+"-minute "+(existing.source_url?"video":"recording")+" of "+streamer.name+". Pick clips from it under Recordings.",now));
  }
  await db.batch(statements);
  return Response.json({ok:true});
 }catch(error){console.error("Recording report failed",error);return Response.json({error:"Recording report not saved."},{status:503});}
}
