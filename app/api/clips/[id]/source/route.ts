import { currentUser } from "../../../../auth";
import { bucket, database } from "../../../../../db/raw";
import { serveClip } from "../../../../../lib/serve-clip";
export const dynamic="force-dynamic";
// Streams a clip's unframed source to its owner, for the editor's preview.
export async function GET(request:Request,{params}:{params:Promise<{id:string}>}){
 const user=await currentUser();if(!user)return new Response("Sign in to edit clips.",{status:401});
 const store=bucket();if(!store)return new Response("Clip storage is not enabled.",{status:404});
 const {id}=await params;
 const clip=await database().prepare("SELECT source_key FROM clips WHERE id=? AND owner=?").bind(id,user.userId).first<{source_key:string|null}>();
 if(!clip?.source_key)return new Response("Source not stored.",{status:404});
 return serveClip(store,clip.source_key,request,{cache:"private, max-age=3600"});
}
