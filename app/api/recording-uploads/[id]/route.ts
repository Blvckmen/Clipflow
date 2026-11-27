import { videoContainer } from "../../../../worker/upload-format.mjs";
import { currentUser } from "../../../auth";
import { bucket,database } from "../../../../db/raw";
import { defaults } from "../../../../lib/clipflow";
import { discardUpload,recordingSourceKey,UPLOAD_PART_BYTES,type UploadRow } from "../../../../lib/recording-upload";
type Context={params:Promise<{id:string}>};
async function owned(request:Request,context:Context){
 const user=await currentUser();if(!user)return {error:Response.json({error:"Sign in first."},{status:401})};
 if(request.headers.get("origin")&&request.headers.get("origin")!==new URL(request.url).origin)return {error:Response.json({error:"Request origin rejected."},{status:403})};
 const db=database(),store=bucket(),{id}=await context.params;
 if(!store)return {error:Response.json({error:"Video storage is not enabled."},{status:501})};
 const row=await db.prepare("SELECT * FROM recording_uploads WHERE id=? AND owner=?").bind(id,user.userId).first<UploadRow>();
 if(!row)return {error:Response.json({error:"Upload not found."},{status:404})};
 return {db,store,row};
}
export async function PUT(request:Request,context:Context){
 try{return await uploadPart(request,context);}finally{
  // Rejected and retried parts may still have a request body in flight. Read it to the end rather than cancel it:
  // a cancelled body can drop the connection, so the browser's (or a test's) next request on it fails.
  if(request.body&&!request.body.locked){const reader=request.body.getReader();try{while(!(await reader.read()).done){}}catch{}}
 }
}
async function uploadPart(request:Request,context:Context){
 const r=await owned(request,context);if("error" in r)return r.error;
 const {db,store,row}=r,part=Number(request.headers.get("x-part")),total=Math.ceil(row.size/UPLOAD_PART_BYTES);
 if(row.complete||!row.upload_id)return Response.json({error:"Upload already completed."},{status:409});
 const done=JSON.parse(row.parts) as R2UploadedPart[];
 if(!Number.isInteger(part)||part<1||part>total||part>done.length+1)return Response.json({error:"Invalid or out-of-order part."},{status:400});
 // An acknowledged part can be retried after a lost response, without duplicating it.
 if(part<=done.length)return Response.json({ok:true});
 const expected=part===total?row.size-(total-1)*UPLOAD_PART_BYTES:UPLOAD_PART_BYTES;
 if(Number(request.headers.get("content-length"))!==expected)return Response.json({error:"Incorrect upload part size."},{status:400});
 const reader=request.body?.getReader();if(!reader)return Response.json({error:"Empty upload."},{status:400});
 const chunks:Uint8Array[]=[];let size=0;
 for(;;){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.length;if(size>expected){await reader.cancel();return Response.json({error:"Upload part too large."},{status:413});}chunks.push(chunk.value);}
 if(size!==expected)return Response.json({error:"Incomplete upload part. Please retry."},{status:400});
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
 if(part===1&&!videoContainer(bytes))return Response.json({error:"This file is not a supported video container. Choose an MP4, MOV, MKV or WebM video."},{status:415});
 const uploaded=await store.resumeMultipartUpload(recordingSourceKey(row.id),row.upload_id).uploadPart(part,bytes);
 const saved=await db.prepare("UPDATE recording_uploads SET parts=? WHERE id=? AND owner=? AND parts=? AND complete=0").bind(JSON.stringify([...done,uploaded]),row.id,row.owner,row.parts).run();
 if(!saved.meta.changes)return Response.json({error:"Upload changed. Please retry."},{status:409});
 return Response.json({ok:true});
}
export async function POST(request:Request,context:Context){
 const r=await owned(request,context);if("error" in r)return r.error;
 const {db,store,row}=r;if(row.complete)return Response.json({ok:true,id:row.id});
 const parts=JSON.parse(row.parts) as R2UploadedPart[];
 if(!row.upload_id||parts.length!==Math.ceil(row.size/UPLOAD_PART_BYTES))return Response.json({error:"The video has not finished uploading."},{status:409});
 if(!await db.prepare("SELECT id FROM streamers WHERE id=? AND owner=?").bind(row.streamer_id,row.owner).first())return Response.json({error:"The selected channel was removed. Cancel this upload."},{status:409});
 const key=recordingSourceKey(row.id);
 // A previous completion may have reached R2 but not the database.
 const object=await store.head(key)??await store.resumeMultipartUpload(key,row.upload_id).complete(parts);
 if(object.size!==row.size)return Response.json({error:"Video size does not match. Cancel and upload it again."},{status:400});
 const pref=await db.prepare("SELECT recording_days FROM preferences WHERE owner=?").bind(row.owner).first<{recording_days:number}>();
 const now=new Date().toISOString(),expires=new Date(Date.now()+(pref?.recording_days??defaults.recordingDays)*86400000).toISOString();
 const statements=[
  db.prepare("INSERT OR IGNORE INTO recordings (id,owner,streamer_id,title,started_at,state,source_url,expires_at,created_at) VALUES (?,?,?,?,?,'queued',?,?,?)").bind(row.id,row.owner,row.streamer_id,row.name,now,"upload:"+row.id,expires,now),
  db.prepare("UPDATE recording_uploads SET complete=1,upload_id=NULL WHERE id=? AND owner=?").bind(row.id,row.owner),
 ];
 if(row.clip_count)statements.push(db.prepare("INSERT OR IGNORE INTO recording_requests (id,owner,recording_id,kind,count,state,created_at,updated_at) VALUES (?,?,?,'best',?,'queued',?,?)").bind(row.id,row.owner,row.id,row.clip_count,now,now));
 await db.batch(statements);
 return Response.json({ok:true,id:row.id});
}
export async function DELETE(request:Request,context:Context){
 const r=await owned(request,context);if("error" in r)return r.error;
 if(r.row.complete)return Response.json({error:"Delete this video from Recordings instead."},{status:409});
 await discardUpload(r.row.id,r.store,r.db);return Response.json({ok:true});
}
