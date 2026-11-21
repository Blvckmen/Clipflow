import { bucket, database, sourceKey } from "../../../../../../db/raw";
import { serveClip } from "../../../../../../lib/serve-clip";
import { workerOwner } from "../../../../../../lib/worker-auth";
const MAX_BYTES=64*1024*1024;
const sha256=async(bytes:ArrayBuffer)=>[...new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))].map(b=>b.toString(16).padStart(2,"0")).join("");
// The worker uploads a clip's unframed source once, so the clip stays editable after the worker prunes it.
export async function PUT(request:Request,{params}:{params:Promise<{id:string}>}){
 try{
  const db=database(),owner=await workerOwner(request,db);
  if(!owner)return Response.json({error:"Invalid worker token."},{status:401});
  const store=bucket();
  if(!store)return Response.json({error:"Clip storage is not enabled."},{status:501});
  const {id}=await params;
  const clip=await db.prepare("SELECT source_sha,source_size,source_key FROM clips WHERE id=? AND owner=?").bind(id,owner).first<{source_sha:string|null;source_size:number|null;source_key:string|null}>();
  if(!clip)return Response.json({error:"Report the clip before uploading its source."},{status:404});
  if(!clip.source_sha)return Response.json({error:"This clip was reported without a source."},{status:409});
  if(clip.source_key)return Response.json({ok:true,duplicate:true});
  const declared=Number(request.headers.get("content-length"));
  if(!Number.isFinite(declared)||declared>MAX_BYTES)return Response.json({error:"Source file too large."},{status:413});
  const bytes=await request.arrayBuffer();
  if(bytes.byteLength!==clip.source_size||await sha256(bytes)!==clip.source_sha)return Response.json({error:"Source file does not match its report."},{status:422});
  const key=sourceKey(id);
  await store.put(key,bytes,{httpMetadata:{contentType:"video/mp4"},sha256:clip.source_sha});
  await db.prepare("UPDATE clips SET source_key=? WHERE id=? AND owner=?").bind(key,id,owner).run();
  return Response.json({ok:true});
 }catch(error){console.error("Source upload failed",error);return Response.json({error:"Source file not saved."},{status:503});}
}
// Lets a worker that no longer has the source locally re-render an edited clip.
export async function GET(request:Request,{params}:{params:Promise<{id:string}>}){
 const db=database(),owner=await workerOwner(request,db);
 if(!owner)return Response.json({error:"Invalid worker token."},{status:401});
 const store=bucket(),{id}=await params;
 const clip=await db.prepare("SELECT source_key FROM clips WHERE id=? AND owner=?").bind(id,owner).first<{source_key:string|null}>();
 if(!store||!clip?.source_key)return Response.json({error:"Source not stored."},{status:404});
 return serveClip(store,clip.source_key,request,{cache:"private, no-store"});
}
