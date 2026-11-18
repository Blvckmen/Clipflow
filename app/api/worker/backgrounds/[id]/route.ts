import { bucket, database } from "../../../../../db/raw";
import { workerOwner } from "../../../../../lib/worker-auth";
import { serveClip } from "../../../../../lib/serve-clip";
export const dynamic="force-dynamic";
// Lets the owner's worker download a split-screen background (video or image) to render with.
export async function GET(request:Request,{params}:{params:Promise<{id:string}>}){
 const db=database(),owner=await workerOwner(request,db);
 if(!owner)return Response.json({error:"Invalid worker token."},{status:401});
 const store=bucket();if(!store)return Response.json({error:"Storage is not enabled."},{status:404});
 const {id}=await params;
 const row=await db.prepare("SELECT key,content_type FROM backgrounds WHERE id=? AND owner=?").bind(id,owner).first<{key:string;content_type:string}>();
 if(!row)return Response.json({error:"Background not found."},{status:404});
 return serveClip(store,row.key,request,{cache:"private, no-store",contentType:row.content_type});
}
