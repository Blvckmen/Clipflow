import { currentUser } from "../../../../auth";
import { database } from "../../../../../db/raw";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { configured, generateCopy, providerFor } from "../../../../../lib/ai-copy";

export const dynamic = "force-dynamic";
const platform = z.enum(["TikTok","Instagram","YouTube","Facebook","X"]);
const tone = z.enum(["curiosity","funny","dramatic","informative"]);
const payloadSchema=z.discriminatedUnion("action",[
 z.object({action:z.literal("generate"),platform,tone,transcript:z.string().trim().min(12).max(6000)}),
 z.object({action:z.literal("save"),platform,tone,transcript:z.string().max(6000),hooks:z.array(z.string().trim().min(1).max(160)).max(10),captions:z.array(z.string().trim().min(1).max(2200)).max(10),selectedHook:z.string().max(160),selectedCaption:z.string().max(2200),status:z.enum(["draft","approved"])}),
]);

const headers={"Cache-Control":"private, no-store"};
function parseArray(value:unknown):string[]{try{const v=JSON.parse(String(value??"[]"));return Array.isArray(v)?v.filter(x=>typeof x==="string"):[];}catch{return [];}}

async function getClip(db:D1Database,id:string,owner:string){
 return db.prepare("SELECT c.id,c.duration,c.reason,s.name AS streamer,s.platform AS source FROM clips c LEFT JOIN streamers s ON s.id=c.streamer_id AND s.owner=c.owner WHERE c.id=? AND c.owner=?").bind(id,owner).first<{id:string;duration:number;reason:string|null;streamer:string|null;source:string|null}>();
}
export async function GET(_request:Request,{params}:{params:Promise<{id:string}>}){
 const user=await currentUser();if(!user)return Response.json({error:"Sign in to open AI Copy Studio."},{status:401,headers});
 const {id}=await params;if(!z.string().uuid().safeParse(id).success)return Response.json({error:"Invalid clip id."},{status:400,headers});
 try{
  const db=database(),clip=await getClip(db,id,user.userId);
  if(!clip)return Response.json({error:"Clip not found."},{status:404,headers});
  const row=await db.prepare("SELECT transcript,platform,tone,hooks_json,captions_json,selected_hook,selected_caption,status,updated_at FROM clip_copy WHERE clip_id=? AND owner=?").bind(id,user.userId).first<Record<string,unknown>>();
  return Response.json({clip,copy:{transcript:String(row?.transcript??""),platform:row?.platform??"TikTok",tone:row?.tone??"curiosity",hooks:parseArray(row?.hooks_json),captions:parseArray(row?.captions_json),selectedHook:row?.selected_hook??"",selectedCaption:row?.selected_caption??"",status:row?.status??"draft",updatedAt:row?.updated_at??null},aiConfigured:configured(env),aiProvider:providerFor(env)},{headers});
 }catch(error){console.error("Clip copy load failed",error);return Response.json({error:"Unable to load clip copy. Ensure migration 0007 is applied."},{status:503,headers});}
}
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){
 const user=await currentUser();if(!user)return Response.json({error:"Sign in first."},{status:401,headers});
 const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)return Response.json({error:"Request origin rejected."},{status:403,headers});
 const {id}=await params;if(!z.string().uuid().safeParse(id).success)return Response.json({error:"Invalid clip id."},{status:400,headers});
 let data:z.infer<typeof payloadSchema>;
 try{data=payloadSchema.parse(await request.json());}catch{return Response.json({error:"Invalid copy fields."},{status:400,headers});}
 try{
  const db=database(),clip=await getClip(db,id,user.userId);
  if(!clip)return Response.json({error:"Clip not found."},{status:404,headers});
  if(data.action==="generate"){
   if(!configured(env))return Response.json({error:providerFor(env)==="cloudflare"?"Cloudflare Workers AI binding is missing. Check AI binding configuration.":"OpenAI API key is not configured; switch back to Cloudflare or add the key."},{status:503,headers});
   let result;
   try{result=await generateCopy(env,{platform:data.platform,tone:data.tone,streamer:clip.streamer,source:clip.source,reason:clip.reason,transcript:data.transcript});}
   catch(error){console.error("AI copy generation failed",error instanceof Error?error.message:"Unknown error");return Response.json({error:"AI generation failed or reached its limit. Check your provider configuration and retry."},{status:502,headers});}
   const {hooks,captions}=result;
   await db.prepare("INSERT INTO clip_copy (clip_id,owner,transcript,platform,tone,hooks_json,captions_json,selected_hook,selected_caption,status,updated_at) VALUES (?,?,?,?,?,?,?,?,?,'draft',?) ON CONFLICT(clip_id) DO UPDATE SET transcript=excluded.transcript,platform=excluded.platform,tone=excluded.tone,hooks_json=excluded.hooks_json,captions_json=excluded.captions_json,selected_hook=excluded.selected_hook,selected_caption=excluded.selected_caption,status='draft',updated_at=excluded.updated_at WHERE owner=excluded.owner")
    .bind(id,user.userId,data.transcript,data.platform,data.tone,JSON.stringify(hooks),JSON.stringify(captions),hooks[0],captions[0],new Date().toISOString()).run();
   return Response.json({ok:true,hooks,captions,selectedHook:hooks[0],selectedCaption:captions[0],status:"draft"},{headers});
  }
  if(data.status==="approved"&&(!data.selectedHook.trim()||!data.selectedCaption.trim()))return Response.json({error:"Choose both a hook and caption before approving."},{status:400,headers});
  // A manual save always replaces the current draft for this owner and clip. Approval only governs the selected caption.
  await db.prepare("INSERT INTO clip_copy (clip_id,owner,transcript,platform,tone,hooks_json,captions_json,selected_hook,selected_caption,status,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(clip_id) DO UPDATE SET transcript=excluded.transcript,platform=excluded.platform,tone=excluded.tone,hooks_json=excluded.hooks_json,captions_json=excluded.captions_json,selected_hook=excluded.selected_hook,selected_caption=excluded.selected_caption,status=excluded.status,updated_at=excluded.updated_at WHERE owner=excluded.owner")
   .bind(id,user.userId,data.transcript,data.platform,data.tone,JSON.stringify(data.hooks),JSON.stringify(data.captions),data.selectedHook,data.selectedCaption,data.status,new Date().toISOString()).run();
  return Response.json({ok:true,status:data.status},{headers});
 }catch(error){console.error("Clip copy write failed",error);return Response.json({error:"Unable to save clip copy. Ensure migration 0007 is applied."},{status:503,headers});}
}
