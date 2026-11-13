import { bucket, clipKey, database } from "../../../../../../db/raw";
import { workerOwner } from "../../../../../../lib/worker-auth";
const MAX_BYTES=32*1024*1024;
const sha256=async(bytes:ArrayBuffer)=>[...new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))].map(b=>b.toString(16).padStart(2,"0")).join("");
export async function PUT(request:Request,{params}:{params:Promise<{id:string}>}){
 try{
  const db=database(),owner=await workerOwner(request,db);
  if(!owner)return Response.json({error:"Invalid worker token."},{status:401});
  const store=bucket();
  // 501 tells the worker to keep the file locally instead of retrying.
  if(!store)return Response.json({error:"Clip storage is not enabled."},{status:501});
  const {id}=await params;
  const clip=await db.prepare("SELECT sha,size,file_key FROM clips WHERE id=? AND owner=?").bind(id,owner).first<{sha:string;size:number;file_key:string|null}>();
  if(!clip)return Response.json({error:"Report the clip before uploading it."},{status:404});
  if(clip.file_key)return Response.json({ok:true,duplicate:true});
  const declared=Number(request.headers.get("content-length"));
  if(!Number.isFinite(declared)||declared>MAX_BYTES)return Response.json({error:"Clip file too large."},{status:413});
  const bytes=await request.arrayBuffer();
  if(bytes.byteLength!==clip.size||await sha256(bytes)!==clip.sha)return Response.json({error:"Clip file does not match its report."},{status:422});
  const key=clipKey(id);
  await store.put(key,bytes,{httpMetadata:{contentType:"video/mp4"},sha256:clip.sha});
  await db.prepare("UPDATE clips SET file_key=? WHERE id=? AND owner=?").bind(key,id,owner).run();
  return Response.json({ok:true});
 }catch(error){console.error("Clip upload failed",error);return Response.json({error:"Clip file not saved."},{status:503});}
}
