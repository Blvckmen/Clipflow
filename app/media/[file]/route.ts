import { env } from "cloudflare:workers";
import { bucket, database } from "../../../db/raw";
import { serveClip } from "../../../lib/serve-clip";
import { verifyMediaSignature } from "../../../lib/secure";
export const dynamic="force-dynamic";
// Public, time-limited clip links for platforms that fetch the video themselves (Instagram's video_url).
// The HMAC signature is the authorisation, so this path is exempt from sign-in; it reveals nothing without one.
export async function GET(request:Request,{params}:{params:Promise<{file:string}>}){
 const {file}=await params;
 // <clip id>.mp4, or <clip id>-<lang>.mp4 for its version in another language (clip_translations).
 const m=/^([0-9a-f-]{36})(?:-(es|pt|fr))?\.mp4$/i.exec(file),id=m?.[1],lang=m?.[2]?.toLowerCase();
 const url=new URL(request.url),store=bucket();
 if(!id||!store||!env.MEDIA_KEY||!await verifyMediaSignature(lang?id+"-"+lang:id,url.searchParams.get("e"),url.searchParams.get("s"),env.MEDIA_KEY))return new Response("Not found.",{status:404});
 const clip=lang?await database().prepare("SELECT file_key FROM clip_translations WHERE clip_id=? AND lang=? AND state='ready'").bind(id,lang).first<{file_key:string|null}>()
  :await database().prepare("SELECT file_key FROM clips WHERE id=?").bind(id).first<{file_key:string|null}>();
 if(!clip?.file_key)return new Response("Not found.",{status:404});
 return serveClip(store,clip.file_key,request,{cache:"private, no-store"});
}
