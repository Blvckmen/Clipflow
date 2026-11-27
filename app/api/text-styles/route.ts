import { currentUser } from "../../auth";
import { database } from "../../../db/raw";
export const dynamic="force-dynamic";
const parse=(json:string)=>{try{return JSON.parse(json);}catch{return null;}};

// The workspace's saved text styles (worker/text-style.mjs), for the clip editor's Saved looks. Saving and deleting
// go through POST /api/dashboard (saveTextStyle, deleteTextStyle).
export async function GET(){
 const user=await currentUser();if(!user)return Response.json({error:"Sign in to see your text styles."},{status:401});
 const {results}=await database().prepare("SELECT id,name,style FROM text_styles WHERE owner=? ORDER BY name COLLATE NOCASE").bind(user.userId).all<{id:string;name:string;style:string}>();
 return Response.json({styles:results.map(r=>({id:r.id,name:r.name,style:parse(r.style)})).filter(s=>s.style)},{headers:{"Cache-Control":"private, no-store"}});
}
