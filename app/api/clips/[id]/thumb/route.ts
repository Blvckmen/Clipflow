import { currentUser } from "../../../../auth";
import { bucket, database } from "../../../../../db/raw";
import { serveClip } from "../../../../../lib/serve-clip";
import { THUMB_MAX_BYTES, thumbKey } from "../../../../../lib/thumbs";
export const dynamic="force-dynamic";
type Row={edit_rev:number;thumb_rev:number|null;file_key:string|null;render_state:string|null};
// The clip's library thumbnail. The URL carries the revision (?v=), so the browser can keep it for a long time.
export async function GET(request:Request,{params}:{params:Promise<{id:string}>}){
 const user=await currentUser();if(!user)return new Response("Sign in to view clips.",{status:401});
 const store=bucket();if(!store)return new Response("Clip storage is not enabled.",{status:404});
 const {id}=await params;
 const clip=await database().prepare("SELECT thumb_rev FROM clips WHERE id=? AND owner=?").bind(id,user.userId).first<{thumb_rev:number|null}>();
 if(clip?.thumb_rev==null)return new Response("No thumbnail yet.",{status:404});
 return serveClip(store,thumbKey(user.userId,id,clip.thumb_rev),request,{cache:"private, max-age=604800, immutable",contentType:"image/jpeg"});
}
// Saves the still the browser took from the clip's current version (?rev= the edit_rev it was taken from). Refused for
// an older revision, or while an edit is still rendering (the file shown then is the previous version).
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){
 const user=await currentUser();if(!user)return Response.json({error:"Sign in first."},{status:401});
 const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)return Response.json({error:"Request origin rejected."},{status:403});
 const store=bucket();if(!store)return Response.json({error:"Clip storage is not enabled."},{status:404});
 const {id}=await params,owner=user.userId,rev=Number(new URL(request.url).searchParams.get("rev"));
 if(request.headers.get("content-type")!=="image/jpeg")return Response.json({error:"Send a JPEG."},{status:415});
 const bytes=new Uint8Array(await request.arrayBuffer());
 // A JPEG starts with FF D8 FF; anything else (or anything big) isn't a thumbnail.
 if(bytes.byteLength<100||bytes.byteLength>THUMB_MAX_BYTES||bytes[0]!==0xff||bytes[1]!==0xd8||bytes[2]!==0xff)return Response.json({error:"That isn't a thumbnail."},{status:400});
 const db=database(),clip=await db.prepare("SELECT edit_rev,thumb_rev,file_key,render_state FROM clips WHERE id=? AND owner=?").bind(id,owner).first<Row>();
 if(!clip?.file_key)return Response.json({error:"Clip not found."},{status:404});
 if(!Number.isInteger(rev)||rev!==clip.edit_rev||clip.render_state==="queued")return Response.json({error:"The clip has changed since; it gets a thumbnail when its new version is shown."},{status:409});
 if(clip.thumb_rev===rev)return Response.json({ok:true,duplicate:true});
 await store.put(thumbKey(owner,id,rev),bytes,{httpMetadata:{contentType:"image/jpeg"}});
 const saved=await db.prepare("UPDATE clips SET thumb_rev=? WHERE id=? AND owner=? AND edit_rev=?").bind(rev,id,owner,rev).run();
 if(!saved.meta.changes){await store.delete(thumbKey(owner,id,rev));return Response.json({error:"The clip changed while saving."},{status:409});}
 if(clip.thumb_rev!=null)await store.delete(thumbKey(owner,id,clip.thumb_rev));
 return Response.json({ok:true});
}
