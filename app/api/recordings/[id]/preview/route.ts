import { currentUser } from "../../../../auth";
import { bucket, database } from "../../../../../db/raw";
import { serveClip } from "../../../../../lib/serve-clip";
export const dynamic="force-dynamic";
// Streams a recording's small preview to its owner, with Range support so the player can seek through hours.
export async function GET(request:Request,{params}:{params:Promise<{id:string}>}){
 const user=await currentUser();if(!user)return new Response("Sign in to watch recordings.",{status:401});
 const store=bucket();if(!store)return new Response("Clip storage is not enabled.",{status:404});
 const {id}=await params;
 const row=await database().prepare("SELECT preview_key FROM recordings WHERE id=? AND owner=?").bind(id,user.userId).first<{preview_key:string|null}>();
 if(!row?.preview_key)return new Response("Preview not ready.",{status:404});
 return serveClip(store,row.preview_key,request,{cache:"private, max-age=3600"});
}
