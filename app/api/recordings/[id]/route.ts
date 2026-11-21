import { currentUser } from "../../../auth";
import { database } from "../../../../db/raw";
export const dynamic="force-dynamic";
// A recording's heat strip (loudness and chat), for the Recordings player. Kept out of the dashboard load because
// each one is a few thousand numbers.
export async function GET(_request:Request,{params}:{params:Promise<{id:string}>}){
 const user=await currentUser();if(!user)return Response.json({error:"Sign in to see recordings."},{status:401});
 const {id}=await params;
 const row=await database().prepare("SELECT signals FROM recordings WHERE id=? AND owner=?").bind(id,user.userId).first<{signals:string|null}>();
 if(!row)return Response.json({error:"Recording not found."},{status:404});
 let signals=null;try{signals=row.signals?JSON.parse(row.signals):null;}catch{/* unreadable: no strip */}
 return Response.json({signals},{headers:{"Cache-Control":"private, max-age=60"}});
}
