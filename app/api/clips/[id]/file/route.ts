import { currentUser } from "../../../../auth";
import { bucket, database } from "../../../../../db/raw";
import { serveClip } from "../../../../../lib/serve-clip";
export const dynamic="force-dynamic";
// Streams a stored clip to its owner.
export async function GET(request:Request,{params}:{params:Promise<{id:string}>}){
 const user=await currentUser();if(!user)return new Response("Sign in to view clips.",{status:401});
 const store=bucket();if(!store)return new Response("Clip storage is not enabled.",{status:404});
 const {id}=await params;
 const clip=await database().prepare("SELECT file_key,created_at FROM clips WHERE id=? AND owner=?").bind(id,user.userId).first<{file_key:string|null;created_at:string}>();
 if(!clip?.file_key)return new Response("Clip file not found.",{status:404});
 const download=new URL(request.url).searchParams.has("download");
 return serveClip(store,clip.file_key,request,{cache:"private, max-age=3600",filename:download?`clip-${clip.created_at.slice(0,19).replace(/[:T]/g,"-")}.mp4`:undefined});
}
