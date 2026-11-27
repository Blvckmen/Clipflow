import { z } from "zod";
import { currentUser } from "../../auth";
import { bucket, database } from "../../../db/raw";
import { MAX_UPLOAD_BYTES, UPLOAD_PART_BYTES, recordingSourceKey, validVideoName } from "../../../lib/recording-upload";
export async function POST(request:Request){
 const user=await currentUser();if(!user)return Response.json({error:"Sign in first."},{status:401});
 if(request.headers.get("origin")&&request.headers.get("origin")!==new URL(request.url).origin)return Response.json({error:"Request origin rejected."},{status:403});
 const store=bucket();if(!store)return Response.json({error:"Video storage is not enabled."},{status:501});
 const parsed=z.object({name:z.string().min(1).max(255).refine(validVideoName),size:z.number().int().min(1).max(MAX_UPLOAD_BYTES),count:z.number().int().min(0).max(10),streamerId:z.string().uuid()}).safeParse(await request.json().catch(()=>null));
 if(!parsed.success)return Response.json({error:"Choose an MP4, MOV, MKV or WebM video up to 2 GB and 0 to 10 clips."},{status:400});
 const b=parsed.data;
 const db=database(),owner=user.userId;
 if(!await db.prepare("SELECT id FROM streamers WHERE id=? AND owner=?").bind(b.streamerId,owner).first())return Response.json({error:"Choose one of your channels."},{status:404});
 const pending=await db.prepare("SELECT count(*) AS n FROM recording_uploads WHERE owner=?").bind(owner).first<{n:number}>();
 if((pending?.n??0)>=5)return Response.json({error:"You can keep five uploaded videos at once. Delete a recording or cancel an upload first."},{status:429});
 const id=crypto.randomUUID(),upload=await store.createMultipartUpload(recordingSourceKey(id),{httpMetadata:{contentType:"application/octet-stream"}});
 try{
  await db.prepare("INSERT INTO recording_uploads (id,owner,streamer_id,name,size,clip_count,upload_id,created_at) VALUES (?,?,?,?,?,?,?,?)").bind(id,owner,b.streamerId,b.name.replace(/[\\/\x00-\x1f]/g,"_").slice(0,200),b.size,b.count,upload.uploadId,new Date().toISOString()).run();
 }catch(e){await upload.abort().catch(()=>{});throw e;}
 return Response.json({id,partSize:UPLOAD_PART_BYTES});
}
