import { currentUser } from "../../../../auth";
import { bucket, database } from "../../../../../db/raw";
export const dynamic="force-dynamic";
// Streams a stored clip to its owner, honouring Range so browsers can seek.
export async function GET(request:Request,{params}:{params:Promise<{id:string}>}){
 const user=await currentUser();if(!user)return new Response("Sign in to view clips.",{status:401});
 const store=bucket();if(!store)return new Response("Clip storage is not enabled.",{status:404});
 const {id}=await params;
 const clip=await database().prepare("SELECT file_key,created_at FROM clips WHERE id=? AND owner=?").bind(id,user.userId).first<{file_key:string|null;created_at:string}>();
 if(!clip?.file_key)return new Response("Clip file not found.",{status:404});
 const object=await store.get(clip.file_key,{range:request.headers,onlyIf:request.headers});
 if(!object)return new Response("Clip file not found.",{status:404});
 const headers=new Headers({"Content-Type":"video/mp4","Accept-Ranges":"bytes","Cache-Control":"private, max-age=3600","ETag":object.httpEtag});
 if(new URL(request.url).searchParams.has("download"))headers.set("Content-Disposition",`attachment; filename="clip-${clip.created_at.slice(0,19).replace(/[:T]/g,"-")}.mp4"`);
 if(!("body" in object))return new Response(null,{status:304,headers});
 const range=object.range as {offset:number;length:number}|undefined;
 if(range&&request.headers.has("range")){
  headers.set("Content-Range",`bytes ${range.offset}-${range.offset+range.length-1}/${object.size}`);headers.set("Content-Length",String(range.length));
  return new Response(object.body,{status:206,headers});
 }
 headers.set("Content-Length",String(object.size));
 return new Response(object.body,{headers});
}
