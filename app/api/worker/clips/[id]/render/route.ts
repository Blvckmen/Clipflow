import { z } from "zod";
import { bucket, database } from "../../../../../../db/raw";
import { workerOwner } from "../../../../../../lib/worker-auth";
const MAX_BYTES=32*1024*1024;
const sha256=async(bytes:ArrayBuffer)=>[...new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))].map(b=>b.toString(16).padStart(2,"0")).join("");
type Clip={edit_rev:number;render_state:string|null;file_key:string|null;edit:string|null};
const current=(db:D1Database,id:string,owner:string)=>db.prepare("SELECT edit_rev,render_state,file_key,edit FROM clips WHERE id=? AND owner=?").bind(id,owner).first<Clip>();
// The worker uploads a clip re-rendered with the edit revision named in x-edit-rev. It replaces the clip's file
// only if that is still the newest edit; otherwise 409 and the newer revision is rendered next.
export async function PUT(request:Request,{params}:{params:Promise<{id:string}>}){
 try{
  const db=database(),owner=await workerOwner(request,db);
  if(!owner)return Response.json({error:"Invalid worker token."},{status:401});
  const store=bucket();
  if(!store)return Response.json({error:"Clip storage is not enabled."},{status:501});
  const {id}=await params,rev=Number(request.headers.get("x-edit-rev")),declaredSha=request.headers.get("x-clip-sha256")??"";
  const clip=await current(db,id,owner);
  if(!clip)return Response.json({error:"Clip not found."},{status:404});
  if(!Number.isInteger(rev)||rev!==clip.edit_rev||clip.render_state!=="queued")return Response.json({error:"A newer edit is waiting, or this one was already rendered."},{status:409});
  const declared=Number(request.headers.get("content-length"));
  if(!Number.isFinite(declared)||declared>MAX_BYTES)return Response.json({error:"Clip file too large."},{status:413});
  const bytes=await request.arrayBuffer();
  if(bytes.byteLength<1024)return Response.json({error:"Clip file too small."},{status:422});
  const sha=await sha256(bytes);
  if(sha!==declaredSha)return Response.json({error:"Clip file does not match its hash."},{status:422});
  // A new key per revision: browsers and platforms that cached the old file never see a mix of the two.
  const key="clips/"+id+"-r"+rev+".mp4",iso=new Date().toISOString();
  await store.put(key,bytes,{httpMetadata:{contentType:"video/mp4"},sha256:sha});
  const edit=JSON.parse(clip.edit??"{}") as {trim?:{start:number;end:number}};
  const duration=edit.trim?Math.round(edit.trim.end-edit.trim.start):null;
  const saved=await db.prepare("UPDATE clips SET file_key=?,sha=?,size=?,duration=coalesce(?,duration),render_state=NULL,render_error=NULL,rendered_at=? WHERE id=? AND owner=? AND edit_rev=?").bind(key,sha,bytes.byteLength,duration,iso,id,owner,rev).run();
  if(!saved.meta.changes){await store.delete(key);return Response.json({error:"A newer edit is waiting."},{status:409});}
  if(clip.file_key&&clip.file_key!==key)await store.delete(clip.file_key);
  return Response.json({ok:true});
 }catch(error){console.error("Render upload failed",error);return Response.json({error:"Rendered clip not saved."},{status:503});}
}
// The worker reports a render it could not finish; the editor shows the reason and the old file stays.
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){
 try{
  const db=database(),owner=await workerOwner(request,db);
  if(!owner)return Response.json({error:"Invalid worker token."},{status:401});
  let body;try{body=z.object({rev:z.number().int(),error:z.string().max(300)}).parse(await request.json());}catch{return Response.json({error:"Invalid render report."},{status:400});}
  const {id}=await params;
  await db.prepare("UPDATE clips SET render_state='failed',render_error=? WHERE id=? AND owner=? AND edit_rev=? AND render_state='queued'").bind(body.error,id,owner,body.rev).run();
  return Response.json({ok:true});
 }catch(error){console.error("Render report failed",error);return Response.json({error:"Render report not saved."},{status:503});}
}
