import { z } from "zod";
import { database } from "../../../../db/raw";
import { workerOwner } from "../../../../lib/worker-auth";
// Viewers' Twitch clips with "ask me first" (lib/viewer-clips.mjs). The worker offers the clips it finds; they wait in
// the dashboard until picked (state wanted, sent back in the worker config as viewerClipPicks) or dismissed. Once the
// worker has made a picked one it reports it imported (with the new clip's id) or failed.
const clipId=z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
// Twitch's own image hosts only, so the dashboard never loads an image from anywhere else.
const thumbnail=z.string().max(500).regex(/^https:\/\/([a-z0-9-]+\.)*(twitch\.tv|jtvnw\.net)\//).nullish().catch(null);
const bodySchema=z.object({
 offer:z.array(z.object({id:clipId,streamerId:z.string().uuid(),title:z.string().max(300),views:z.number().int().min(0),duration:z.number().min(0).max(600),creator:z.string().max(100).nullish(),thumbnail,
  createdAt:z.string().datetime(),momentAt:z.string().datetime().nullish(),videoId:z.string().max(40).nullish(),vodOffset:z.number().int().min(0).nullish()})).max(50).default([]),
 done:z.array(z.object({id:clipId,state:z.enum(["imported","failed"]),clip:z.string().uuid().nullish(),error:z.string().max(300).nullish()})).max(50).default([]),
});
export async function POST(request:Request){
 try{
  const db=database(),owner=await workerOwner(request,db);
  if(!owner)return Response.json({error:"Invalid worker token."},{status:401});
  let body;try{body=bodySchema.parse(await request.json());}catch{return Response.json({error:"Invalid viewer clips report."},{status:400});}
  const iso=new Date().toISOString();
  const statements=[
   // A clip offered again (it is still in Twitch's list) only gets its new view count; one already dismissed or made
   // stays that way. Only the owner's own streamers.
   ...body.offer.map(c=>db.prepare("INSERT INTO viewer_clip_candidates (owner,clip_id,streamer_id,title,views,duration,creator,thumbnail,clip_created_at,moment_at,video_id,vod_offset,state,created_at,updated_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,'waiting',?,? WHERE EXISTS (SELECT 1 FROM streamers WHERE id=? AND owner=?) ON CONFLICT(owner,clip_id) DO UPDATE SET views=excluded.views")
    .bind(owner,c.id,c.streamerId,c.title.trim()||"Untitled clip",c.views,c.duration,c.creator??null,c.thumbnail??null,c.createdAt,c.momentAt??null,c.videoId??null,c.vodOffset??null,iso,iso,c.streamerId,owner)),
   ...body.done.map(d=>db.prepare("UPDATE viewer_clip_candidates SET state=?,made_clip=?,error=?,updated_at=? WHERE owner=? AND clip_id=? AND state='wanted'").bind(d.state,d.clip??null,d.state==="failed"?(d.error??"The worker couldn't make it."):null,iso,owner,d.id)),
   // Old ones go after two weeks (the dashboard shows the last 3 days).
   db.prepare("DELETE FROM viewer_clip_candidates WHERE owner=? AND created_at<?").bind(owner,new Date(Date.now()-14*86_400_000).toISOString()),
  ];
  await db.batch(statements);
  return Response.json({ok:true,offered:body.offer.length,done:body.done.length});
 }catch(error){console.error("Viewer clips report failed",error);return Response.json({error:"Viewer clips not saved."},{status:503});}
}
