import { z } from "zod";
import { bucket, database, translationKey } from "../../../../../../db/raw";
import { workerOwner } from "../../../../../../lib/worker-auth";
const MAX_BYTES=32*1024*1024;
const sha256=async(bytes:ArrayBuffer)=>[...new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))].map(b=>b.toString(16).padStart(2,"0")).join("");
const LANG=/^(es|pt|fr)$/;
type Row={rev:number;state:string;file_key:string|null};
// The worker uploads a clip's version in another language (x-lang), rendered from edit revision x-rev, with its
// translated post caption (x-caption, URI-encoded). Kept only while that version is still the one asked for.
export async function PUT(request:Request,{params}:{params:Promise<{id:string}>}){
 try{
  const db=database(),owner=await workerOwner(request,db);
  if(!owner)return Response.json({error:"Invalid worker token."},{status:401});
  const store=bucket();
  if(!store)return Response.json({error:"Clip storage is not enabled."},{status:501});
  const {id}=await params,lang=request.headers.get("x-lang")??"",rev=Number(request.headers.get("x-rev"));
  if(!LANG.test(lang)||!Number.isInteger(rev))return Response.json({error:"Invalid translation upload."},{status:400});
  const row=await db.prepare("SELECT rev,state,file_key FROM clip_translations WHERE clip_id=? AND lang=? AND owner=?").bind(id,lang,owner).first<Row>();
  if(!row||row.rev!==rev||row.state!=="queued")return Response.json({error:"This version is no longer wanted."},{status:409});
  if(Number(request.headers.get("content-length"))>MAX_BYTES)return Response.json({error:"Clip file too large."},{status:413});
  let caption:string|null=null;
  try{const c=request.headers.get("x-caption");caption=c?decodeURIComponent(c).slice(0,2200):null;}catch{return Response.json({error:"Invalid caption."},{status:400});}
  const bytes=await request.arrayBuffer();
  if(bytes.byteLength<1024)return Response.json({error:"Clip file too small."},{status:422});
  const sha=await sha256(bytes);
  if(sha!==request.headers.get("x-clip-sha256"))return Response.json({error:"Clip file does not match its hash."},{status:422});
  const key=translationKey(id,lang,rev);
  await store.put(key,bytes,{httpMetadata:{contentType:"video/mp4"},sha256:sha});
  const saved=await db.prepare("UPDATE clip_translations SET state='ready',file_key=?,caption=?,error=NULL,updated_at=? WHERE clip_id=? AND lang=? AND owner=? AND rev=? AND state='queued'").bind(key,caption,new Date().toISOString(),id,lang,owner,rev).run();
  if(!saved.meta.changes){await store.delete(key);return Response.json({error:"This version is no longer wanted."},{status:409});}
  if(row.file_key&&row.file_key!==key)await store.delete(row.file_key);
  return Response.json({ok:true});
 }catch(error){console.error("Translation upload failed",error);return Response.json({error:"Translated clip not saved."},{status:503});}
}
// The worker reports a version it couldn't make; the publisher then fails the post with the reason.
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){
 try{
  const db=database(),owner=await workerOwner(request,db);
  if(!owner)return Response.json({error:"Invalid worker token."},{status:401});
  let body;try{body=z.object({lang:z.string().regex(LANG),rev:z.number().int(),error:z.string().max(300)}).parse(await request.json());}catch{return Response.json({error:"Invalid translation report."},{status:400});}
  const {id}=await params;
  await db.prepare("UPDATE clip_translations SET state='failed',error=?,updated_at=? WHERE clip_id=? AND lang=? AND owner=? AND rev=? AND state='queued'").bind(body.error,new Date().toISOString(),id,body.lang,owner,body.rev).run();
  return Response.json({ok:true});
 }catch(error){console.error("Translation report failed",error);return Response.json({error:"Translation report not saved."},{status:503});}
}
