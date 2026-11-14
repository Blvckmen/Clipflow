import { z } from "zod";
import { env } from "cloudflare:workers";
import { currentUser } from "../../../../auth";
import { database } from "../../../../../db/raw";
import { CLIP_FACTS_SQL, aiCaptionsAvailable, captionClip } from "../../../../../lib/post-caption";
export const dynamic="force-dynamic";
// "write": have Claude (re)write the clip's post caption now, replacing any earlier one, including one you typed.
// "save": keep your own text; Claude never overwrites it. An empty text clears it, so a new one is written.
const bodySchema=z.discriminatedUnion("action",[
 z.object({action:z.literal("write")}),
 z.object({action:z.literal("save"),text:z.string().max(2200)}),
]);
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){
 const user=await currentUser();if(!user)return Response.json({error:"Sign in to edit clips."},{status:401});
 const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)return Response.json({error:"Request origin rejected."},{status:403});
 let body;try{body=bodySchema.parse(await request.json());}catch{return Response.json({error:"Check the caption and try again."},{status:400});}
 const db=database(),{id}=await params,owner=user.userId;
 const clip=await db.prepare("SELECT id FROM clips WHERE id=? AND owner=?").bind(id,owner).first();
 if(!clip)return Response.json({error:"Clip not found."},{status:404});
 if(body.action==="save"){
  const text=body.text.replace(/\r\n/g,"\n").trim();
  await db.prepare("UPDATE clips SET post_caption=?,caption_source=?,caption_error=NULL,caption_tries=0 WHERE id=? AND owner=?").bind(text||null,text?"edited":null,id,owner).run();
  return Response.json({ok:true,text:text||null,source:text?"edited":null,message:text?"Caption saved. It's used whenever this clip posts.":"Caption cleared. A new one is written before the clip posts."});
 }
 if(!aiCaptionsAvailable(env))return Response.json({error:"Claude isn't set up on this site yet: add ANTHROPIC_API_KEY to .env and deploy."},{status:409});
 // Writing on request replaces whatever is there, so clear the "edited" mark first.
 await db.prepare("UPDATE clips SET caption_source=NULL,caption_tries=0 WHERE id=? AND owner=?").bind(id,owner).run();
 const row=await db.prepare(CLIP_FACTS_SQL+" WHERE c.id=? AND c.owner=?").bind(id,owner).first();
 const text=await captionClip(env,row as Parameters<typeof captionClip>[1]);
 if(!text){
  const failed=await db.prepare("SELECT caption_error FROM clips WHERE id=?").bind(id).first<{caption_error:string|null}>();
  return Response.json({error:failed?.caption_error??"Claude couldn't write a caption."},{status:502});
 }
 return Response.json({ok:true,text,source:"ai",message:"Claude wrote a new caption."});
}
