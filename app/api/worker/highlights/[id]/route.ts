import { bucket, database, highlightKey } from "../../../../../db/raw";
import { workerOwner } from "../../../../../lib/worker-auth";
// A highlight video arrives in parts (R2 multipart), like a recording's preview: PUT each part in order with x-part
// (1-based) and x-parts, then POST {parts, size, duration} to finish, or POST {error} when it couldn't be made.
const MAX_PART=64*1024*1024,MAX_PARTS=200;
type Row={upload_id:string|null;upload_parts:string|null;file_key:string|null;state:string};
async function owned(request:Request,params:Promise<{id:string}>){
 const db=database(),owner=await workerOwner(request,db);
 if(!owner)return {error:Response.json({error:"Invalid worker token."},{status:401})};
 const store=bucket();
 if(!store)return {error:Response.json({error:"Clip storage is not enabled."},{status:501})};
 const {id}=await params;
 const row=/^[0-9a-f-]{36}$/i.test(id)?await db.prepare("SELECT upload_id,upload_parts,file_key,state FROM highlights WHERE id=? AND owner=?").bind(id,owner).first<Row>():null;
 if(!row)return {error:Response.json({error:"Highlight video not found."},{status:404})};
 return {db,store,id,owner,row};
}
export async function PUT(request:Request,{params}:{params:Promise<{id:string}>}){
 try{
  const r=await owned(request,params);if("error" in r)return r.error;
  const {db,store,id,owner}=r;let {row}=r;
  const part=Number(request.headers.get("x-part")),total=Number(request.headers.get("x-parts")),declared=Number(request.headers.get("content-length"));
  if(!Number.isInteger(part)||!Number.isInteger(total)||part<1||total<1||part>total||total>MAX_PARTS)return Response.json({error:"Bad part number."},{status:400});
  if(!Number.isFinite(declared)||declared<1||declared>MAX_PART)return Response.json({error:"Part too large."},{status:413});
  const key=highlightKey(id);
  if(part===1){
   if(row.upload_id)await store.resumeMultipartUpload(key,row.upload_id).abort().catch(()=>{});
   const upload=await store.createMultipartUpload(key,{httpMetadata:{contentType:"video/mp4"}});
   await db.prepare("UPDATE highlights SET upload_id=?,upload_parts='[]' WHERE id=? AND owner=?").bind(upload.uploadId,id,owner).run();
   row={...row,upload_id:upload.uploadId,upload_parts:"[]"};
  }
  if(!row.upload_id)return Response.json({error:"Send part 1 first."},{status:409});
  const done=JSON.parse(row.upload_parts||"[]") as R2UploadedPart[];
  if(done.length!==part-1)return Response.json({error:"Parts must arrive in order (expected part "+(done.length+1)+")."},{status:409});
  const uploaded=await store.resumeMultipartUpload(key,row.upload_id).uploadPart(part,await request.arrayBuffer());
  await db.prepare("UPDATE highlights SET upload_parts=? WHERE id=? AND owner=?").bind(JSON.stringify([...done,{partNumber:uploaded.partNumber,etag:uploaded.etag}]),id,owner).run();
  return Response.json({ok:true});
 }catch(error){console.error("Highlight part upload failed",error);return Response.json({error:"Highlight part not saved."},{status:503});}
}
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){
 try{
  const r=await owned(request,params);if("error" in r)return r.error;
  const {db,store,id,owner,row}=r,iso=new Date().toISOString();
  let body:{parts?:number;size?:number;duration?:number;error?:string};try{body=await request.json();}catch{return Response.json({error:"Invalid body."},{status:400});}
  if(typeof body.error==="string"){
   if(row.upload_id)await store.resumeMultipartUpload(highlightKey(id),row.upload_id).abort().catch(()=>{});
   await db.prepare("UPDATE highlights SET state='failed',error=?,upload_id=NULL,upload_parts=NULL,updated_at=? WHERE id=? AND owner=?").bind(body.error.slice(0,300),iso,id,owner).run();
   return Response.json({ok:true});
  }
  const done=JSON.parse(row.upload_parts||"[]") as R2UploadedPart[];
  if(!row.upload_id||!done.length||done.length!==body.parts)return Response.json({error:"The video's parts haven't all arrived."},{status:409});
  const key=highlightKey(id),object=await store.resumeMultipartUpload(key,row.upload_id).complete(done);
  const duration=Number.isFinite(body.duration)&&(body.duration as number)>0?Math.round((body.duration as number)*10)/10:null;
  await db.prepare("UPDATE highlights SET state='ready',file_key=?,size=?,duration=?,error=NULL,upload_id=NULL,upload_parts=NULL,updated_at=? WHERE id=? AND owner=?").bind(key,object.size,duration,iso,id,owner).run();
  return Response.json({ok:true});
 }catch(error){console.error("Highlight completion failed",error);return Response.json({error:"Highlight video not saved."},{status:503});}
}
