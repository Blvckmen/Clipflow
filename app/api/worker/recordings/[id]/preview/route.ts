import { bucket, database, previewKey } from "../../../../../../db/raw";
import { workerOwner } from "../../../../../../lib/worker-auth";
// A recording's preview arrives in parts (R2 multipart): PUT each part in order with x-part (1-based) and x-parts,
// then POST {parts, size} to finish. Part 1 starts a fresh upload, so a retried upload simply starts over.
const MAX_PART=64*1024*1024,MAX_PARTS=200;
type Row={upload_id:string|null;upload_parts:string|null;preview_key:string|null};
async function owned(request:Request,params:Promise<{id:string}>){
 const db=database(),owner=await workerOwner(request,db);
 if(!owner)return {error:Response.json({error:"Invalid worker token."},{status:401})};
 const store=bucket();
 if(!store)return {error:Response.json({error:"Clip storage is not enabled."},{status:501})};
 const {id}=await params;
 const row=/^[0-9a-f-]{36}$/i.test(id)?await db.prepare("SELECT upload_id,upload_parts,preview_key FROM recordings WHERE id=? AND owner=?").bind(id,owner).first<Row>():null;
 if(!row)return {error:Response.json({error:"Recording not found."},{status:404})};
 return {db,store,id,owner,row};
}
export async function PUT(request:Request,{params}:{params:Promise<{id:string}>}){
 try{
  const r=await owned(request,params);if("error" in r)return r.error;
  const {db,store,id,owner}=r;let {row}=r;
  const part=Number(request.headers.get("x-part")),total=Number(request.headers.get("x-parts")),declared=Number(request.headers.get("content-length"));
  if(!Number.isInteger(part)||!Number.isInteger(total)||part<1||total<1||part>total||total>MAX_PARTS)return Response.json({error:"Bad part number."},{status:400});
  if(!Number.isFinite(declared)||declared<1||declared>MAX_PART)return Response.json({error:"Part too large."},{status:413});
  const key=previewKey(id);
  if(part===1){
   // Start over: drop an unfinished upload and any earlier preview.
   if(row.upload_id)await store.resumeMultipartUpload(key,row.upload_id).abort().catch(()=>{});
   const upload=await store.createMultipartUpload(key,{httpMetadata:{contentType:"video/mp4"}});
   await db.prepare("UPDATE recordings SET upload_id=?,upload_parts='[]',preview_key=NULL,preview_size=NULL WHERE id=? AND owner=?").bind(upload.uploadId,id,owner).run();
   row={...row,upload_id:upload.uploadId,upload_parts:"[]"};
  }
  if(!row.upload_id)return Response.json({error:"Send part 1 first."},{status:409});
  const done=JSON.parse(row.upload_parts||"[]") as R2UploadedPart[];
  if(done.length!==part-1)return Response.json({error:"Parts must arrive in order (expected part "+(done.length+1)+")."},{status:409});
  const uploaded=await store.resumeMultipartUpload(key,row.upload_id).uploadPart(part,await request.arrayBuffer());
  await db.prepare("UPDATE recordings SET upload_parts=? WHERE id=? AND owner=?").bind(JSON.stringify([...done,{partNumber:uploaded.partNumber,etag:uploaded.etag}]),id,owner).run();
  return Response.json({ok:true});
 }catch(error){console.error("Preview part upload failed",error);return Response.json({error:"Preview part not saved."},{status:503});}
}
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){
 try{
  const r=await owned(request,params);if("error" in r)return r.error;
  const {db,store,id,owner,row}=r;
  let body:{parts?:number;size?:number};try{body=await request.json();}catch{return Response.json({error:"Invalid body."},{status:400});}
  const done=JSON.parse(row.upload_parts||"[]") as R2UploadedPart[];
  if(!row.upload_id||!done.length||done.length!==body.parts)return Response.json({error:"The preview's parts haven't all arrived."},{status:409});
  const key=previewKey(id),object=await store.resumeMultipartUpload(key,row.upload_id).complete(done);
  await db.prepare("UPDATE recordings SET preview_key=?,preview_size=?,upload_id=NULL,upload_parts=NULL WHERE id=? AND owner=?").bind(key,object.size,id,owner).run();
  return Response.json({ok:true});
 }catch(error){console.error("Preview completion failed",error);return Response.json({error:"Preview not saved."},{status:503});}
}
