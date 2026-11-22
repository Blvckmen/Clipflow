import { z } from "zod";
import { env } from "cloudflare:workers";
import { currentUser } from "../../../../auth";
import { bucket, database, sourceKey } from "../../../../../db/raw";
import { aiCaptionsAvailable } from "../../../../../lib/post-caption";
import { defaultEdit, defaultStyle, normalizeEdit, styleOf } from "../../../../../worker/edit.mjs";
export const dynamic="force-dynamic";
const parse=(json:unknown)=>{try{return typeof json==="string"?JSON.parse(json):null;}catch{return null;}};
type Row={id:string;streamer_id:string;edit:string|null;edit_rev:number;transcript:string|null;signals:string|null;source_meta:string|null;source_key:string|null;file_key:string|null;duration:number;render_state:string|null;render_error:string|null;rendered_at:string|null;review:string;reason:string|null;created_at:string;streamer:string|null;streamer_style:string|null;post_caption:string|null;caption_source:string|null;caption_error:string|null;ai_captions:number|null};
const load=(db:D1Database,id:string,owner:string)=>db.prepare("SELECT c.id,c.streamer_id,c.edit,c.edit_rev,c.transcript,c.signals,c.source_meta,c.source_key,c.file_key,c.duration,c.render_state,c.render_error,c.rendered_at,c.review,c.reason,c.created_at,c.post_caption,c.caption_source,c.caption_error,s.name AS streamer,s.style AS streamer_style,p.ai_captions FROM clips c LEFT JOIN streamers s ON s.id=c.streamer_id AND s.owner=c.owner LEFT JOIN preferences p ON p.owner=c.owner WHERE c.id=? AND c.owner=?").bind(id,owner).first<Row>();
const sha256=async(bytes:ArrayBuffer)=>[...new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))].map(b=>b.toString(16).padStart(2,"0")).join("");

// A clip captured before editing existed has only its finished, captioned 720x1280 file. That file becomes its
// source (copied, because a re-render replaces the clip's file), so it can still be trimmed, zoomed, recoloured
// and given a hook title and progress bar. Its captions are part of the picture and can't be restyled.
async function adoptLegacy(db:D1Database,clip:Row,owner:string){
 const store=bucket();
 if(!store||!clip.file_key)return false;
 const object=await store.get(clip.file_key);
 if(!object)return false;
 const bytes=await object.arrayBuffer(),key=sourceKey(clip.id),sha=await sha256(bytes);
 await store.put(key,bytes,{httpMetadata:{contentType:"video/mp4"},sha256:sha});
 const base=defaultStyle({framing:"crop",captions:false});
 const edit=normalizeEdit(defaultEdit(base,{trimStart:0,trimEnd:Math.min(90,clip.duration)}),{duration:clip.duration});
 const saved=await db.prepare("UPDATE clips SET edit=?,transcript='[]',source_meta=?,source_key=?,source_sha=?,source_size=? WHERE id=? AND owner=? AND edit IS NULL")
  .bind(JSON.stringify(edit),JSON.stringify({width:720,height:1280,duration:clip.duration,legacy:true}),key,sha,bytes.byteLength,clip.id,owner).run();
 return saved.meta.changes>0;
}

// Everything the editor needs for one clip: its edit, transcript, heat strip, source details and post caption.
export async function GET(_request:Request,{params}:{params:Promise<{id:string}>}){
 const user=await currentUser();if(!user)return Response.json({error:"Sign in to edit clips."},{status:401});
 const db=database(),{id}=await params;
 let clip=await load(db,id,user.userId);
 if(!clip)return Response.json({error:"Clip not found."},{status:404});
 if(!clip.edit){
  if(!await adoptLegacy(db,clip,user.userId)&&!(await load(db,id,user.userId))?.edit)return Response.json({error:"This clip's file isn't in clip storage, so it can't be edited here."},{status:409});
  clip=(await load(db,id,user.userId))!;
 }
 const source=parse(clip.source_meta);
 return Response.json({id:clip.id,streamerId:clip.streamer_id,streamer:clip.streamer,streamerStyle:parse(clip.streamer_style),edit:parse(clip.edit),rev:clip.edit_rev,words:parse(clip.transcript)??[],signals:parse(clip.signals),source,legacy:!!source?.legacy,sourceStored:!!clip.source_key,pruned:typeof source?.pruned==="string"?source.pruned:null,render:{state:clip.render_state,error:clip.render_error,at:clip.rendered_at},review:clip.review,reason:clip.reason,createdAt:clip.created_at,
  caption:{text:clip.post_caption,source:clip.caption_source,error:clip.caption_error,ai:aiCaptionsAvailable(env)&&clip.ai_captions!==0}},{headers:{"Cache-Control":"private, no-store"}});
}
// Saves an edit and queues the re-render. `saveStyle` also makes this edit's look the default for the clip's
// streamer or for the whole workspace, so future clips come out the same way.
const bodySchema=z.object({edit:z.unknown(),rev:z.number().int().min(0),saveStyle:z.enum(["streamer","workspace"]).optional()});
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){
 const user=await currentUser();if(!user)return Response.json({error:"Sign in to edit clips."},{status:401});
 const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)return Response.json({error:"Request origin rejected."},{status:403});
 let body;try{body=bodySchema.parse(await request.json());}catch{return Response.json({error:"Check the edit and try again."},{status:400});}
 const db=database(),owner=user.userId,{id}=await params,clip=await load(db,id,owner);
 if(!clip)return Response.json({error:"Clip not found."},{status:404});
 const source=parse(clip.source_meta) as {duration:number;pruned?:string}|null;
 if(!clip.edit||!source)return Response.json({error:"This clip has no editable source."},{status:409});
 // Its editable copy was removed after SOURCE_KEEP_DAYS (lib/sources.ts): nothing left to re-render from.
 if(source.pruned&&!clip.source_key)return Response.json({error:"This clip's editable copy was removed to save storage, so it can't be re-edited. The finished clip is unchanged."},{status:409});
 let edit;try{edit=normalizeEdit(body.edit,{duration:source.duration});}catch(error){return Response.json({error:(error as Error).message+"."},{status:400});}
 // Two tabs editing one clip: the later save must have seen the earlier one.
 if(body.rev!==clip.edit_rev)return Response.json({error:"This clip was edited somewhere else. Reopen it to see the latest version."},{status:409});
 const iso=new Date().toISOString(),style=JSON.stringify(styleOf(edit));
 const statements=[db.prepare("UPDATE clips SET edit=?,edit_rev=edit_rev+1,render_state='queued',render_error=NULL,post_caption=CASE WHEN caption_source='local' THEN NULL ELSE post_caption END,caption_source=CASE WHEN caption_source='local' THEN NULL ELSE caption_source END WHERE id=? AND owner=? AND edit_rev=?").bind(JSON.stringify(edit),id,owner,clip.edit_rev)];
 if(body.saveStyle==="streamer")statements.push(db.prepare("UPDATE streamers SET style=? WHERE id=? AND owner=?").bind(style,clip.streamer_id,owner));
 if(body.saveStyle==="workspace")statements.push(db.prepare("INSERT INTO preferences (owner,style) VALUES (?,?) ON CONFLICT(owner) DO UPDATE SET style=excluded.style").bind(owner,style));
 statements.push(db.prepare("INSERT INTO events (id,owner,message,created_at) VALUES (?,?,?,?)").bind(crypto.randomUUID(),owner,"Edited a clip"+(clip.streamer?" from "+clip.streamer:"")+"; the worker will render the new version."+(body.saveStyle==="streamer"?" Saved its look for "+(clip.streamer??"this streamer")+"'s new clips.":body.saveStyle==="workspace"?" Saved its look as the workspace default.":""),iso));
 const [saved]=await db.batch(statements);
 if(!saved.meta.changes)return Response.json({error:"This clip was edited somewhere else. Reopen it to see the latest version."},{status:409});
 return Response.json({ok:true,rev:clip.edit_rev+1,message:"Saved. The worker renders the new version within a couple of minutes."});
}
