import { currentUser } from "../../../auth";
import { bucket, database } from "../../../../db/raw";
import { serveClip } from "../../../../lib/serve-clip";
export const dynamic="force-dynamic";
// A highlight video, for its owner: played in the Clip library, or downloaded with ?download=1.
export async function GET(request:Request,{params}:{params:Promise<{id:string}>}){
 const user=await currentUser();if(!user)return Response.json({error:"Sign in to see highlights."},{status:401});
 const {id}=await params,store=bucket();
 const row=await database().prepare("SELECT file_key,title FROM highlights WHERE id=? AND owner=?").bind(id,user.userId).first<{file_key:string|null;title:string}>();
 if(!row?.file_key||!store)return Response.json({error:"Highlight video not found."},{status:404});
 const download=new URL(request.url).searchParams.has("download");
 return serveClip(store,row.file_key,request,{cache:"private, max-age=3600",...(download&&{filename:row.title.replace(/[^\w .()-]+/g,"").trim().replace(/\s+/g,"-").slice(0,80)+".mp4"})});
}
