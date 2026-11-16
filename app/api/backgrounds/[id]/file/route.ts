import { currentUser } from "../../../../auth";
import { bucket, database } from "../../../../../db/raw";
import { serveClip } from "../../../../../lib/serve-clip";
export const dynamic="force-dynamic";
// Streams a background video to its owner (previews in Settings and the clip editor).
export async function GET(request:Request,{params}:{params:Promise<{id:string}>}){
 const user=await currentUser();if(!user)return new Response("Sign in first.",{status:401});
 const store=bucket();if(!store)return new Response("Storage is not enabled.",{status:404});
 const {id}=await params;
 const row=await database().prepare("SELECT key FROM backgrounds WHERE id=? AND owner=?").bind(id,user.userId).first<{key:string}>();
 if(!row)return new Response("Not found.",{status:404});
 return serveClip(store,row.key,request,{cache:"private, max-age=86400"});
}
