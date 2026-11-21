import { currentUser } from "../../../../auth";
import { bucket, database, transcriptKey } from "../../../../../db/raw";
export const dynamic="force-dynamic";
// A recording's whole transcript, for searching what was said on the Recordings page (searched in the browser).
export async function GET(_request:Request,{params}:{params:Promise<{id:string}>}){
 const user=await currentUser();if(!user)return Response.json({error:"Sign in to see recordings."},{status:401});
 const {id}=await params;
 const row=await database().prepare("SELECT transcript_at FROM recordings WHERE id=? AND owner=?").bind(id,user.userId).first<{transcript_at:string|null}>();
 if(!row)return Response.json({error:"Recording not found."},{status:404});
 const object=row.transcript_at?await bucket()?.get(transcriptKey(id)):null;
 if(!object)return Response.json({error:"This recording hasn't been transcribed yet."},{status:404});
 return new Response(object.body,{headers:{"content-type":"application/json","Cache-Control":"private, max-age=300"}});
}
