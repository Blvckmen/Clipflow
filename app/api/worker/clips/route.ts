import { z } from "zod";
import { database } from "../../../../db/raw";
import { workerOwner } from "../../../../lib/worker-auth";
import { normalizeEdit, normalizeWords } from "../../../../worker/edit.mjs";
const box=z.object({x:z.number().min(0).max(1),y:z.number().min(0).max(1),w:z.number().min(0.01).max(1),h:z.number().min(0.01).max(1)});
const sha=z.string().regex(/^[0-9a-f]{64}$/);
// Editor material is optional so older workers keep working; their clips just can't be edited.
const clipSchema=z.object({id:z.string().uuid(),streamerId:z.string().uuid(),createdAt:z.string().datetime(),duration:z.number().int().min(15).max(90),captions:z.boolean(),sha,size:z.number().int().min(1024).max(32*1024*1024),reason:z.enum(["chat","audio","best","manual"]).optional(),
 edit:z.unknown().optional(),transcript:z.unknown().optional(),
 // A post caption written by the AI writer on the worker (worker/writer.mjs); without it one is made from the transcript.
 postCaption:z.string().trim().min(1).max(2200).optional(),
 signals:z.object({energy:z.array(z.number().min(0).max(1)).max(200),chat:z.array(z.number().int().min(0).max(100000)).max(200)}).optional(),
 source:z.object({width:z.number().int().min(0).max(8192),height:z.number().int().min(0).max(8192),duration:z.number().min(1).max(200),sha,size:z.number().int().min(1024).max(64*1024*1024),
  // The streamer's webcam overlay found by the worker (fractions of the frame), for the facecam layouts.
  face:box.nullish(),
  // A phone stream's upright picture inside the black bars (fractions of the frame), for phone mode.
  content:box.nullish()}).optional()});
const reasonText={chat:" after a chat spike",audio:" at its loudest moment",best:" from one of the best moments of a recording",manual:" from a recording, at the moment you picked"};
export async function POST(request:Request){
 try{
  const db=database(),owner=await workerOwner(request,db);
  if(!owner)return Response.json({error:"Invalid worker token."},{status:401});
  let clip,edit=null,words=null;
  try{
   clip=clipSchema.parse(await request.json());
   if(clip.source&&clip.edit!==undefined){edit=normalizeEdit(clip.edit,{duration:clip.source.duration});words=normalizeWords(clip.transcript??[],clip.source.duration);}
  }catch{return Response.json({error:"Invalid clip report."},{status:400});}
  const streamer=await db.prepare("SELECT name,publish_mode FROM streamers WHERE id=? AND owner=?").bind(clip.streamerId,owner).first<{name:string;publish_mode:string|null}>();
  if(!streamer)return Response.json({error:"Streamer not found."},{status:404});
  // Reports are retried by the worker, so a repeated id is acknowledged without a second log entry.
  const existing=await db.prepare("SELECT owner FROM clips WHERE id=?").bind(clip.id).first<{owner:string}>();
  if(existing)return existing.owner===owner?Response.json({ok:true,duplicate:true}):Response.json({error:"Clip id conflict."},{status:409});
  // The publishing mode at arrival decides whether the clip waits for review: the streamer's own, else the workspace's.
  const prefs=await db.prepare("SELECT mode FROM preferences WHERE owner=?").bind(owner).first<{mode:string}>();
  const review=(streamer.publish_mode??prefs?.mode)==="review"?"pending":"approved";
  const src=clip.source,iso=new Date().toISOString();
  await db.batch([
   db.prepare("INSERT INTO clips (id,owner,streamer_id,created_at,duration,captions,sha,size,review,reason,edit,transcript,signals,source_meta,source_sha,source_size,rendered_at,post_caption,caption_source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .bind(clip.id,owner,clip.streamerId,clip.createdAt,clip.duration,Number(clip.captions),clip.sha,clip.size,review,clip.reason??null,
     edit?JSON.stringify(edit):null,words?JSON.stringify(words):null,edit&&clip.signals?JSON.stringify(clip.signals):null,edit&&src?JSON.stringify({width:src.width,height:src.height,duration:src.duration,...(src.face&&{face:src.face}),...(src.content&&{content:src.content})}):null,edit&&src?src.sha:null,edit&&src?src.size:null,edit?iso:null,clip.postCaption??null,clip.postCaption?"ai":null),
   db.prepare("INSERT INTO events (id,owner,message,created_at) VALUES (?,?,?,?)").bind(crypto.randomUUID(),owner,"Worker captured a "+clip.duration+"s clip from "+streamer.name+(clip.reason?reasonText[clip.reason]:"")+(review==="pending"?"; waiting for your review.":"."),iso),
  ]);
  return Response.json({ok:true});
 }catch(error){console.error("Clip report failed",error);return Response.json({error:"Clip report not saved."},{status:503});}
}
