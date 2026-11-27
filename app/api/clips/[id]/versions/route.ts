import { currentUser } from "../../../../auth";
import { database } from "../../../../../db/raw";
import { versionLabel } from "../../../../../lib/versions.mjs";
export const dynamic="force-dynamic";
const parse=(json:string)=>{try{return JSON.parse(json);}catch{return null;}};

// A clip's saved versions (newest first, with a short label), or one version's edit with ?rev=N. The editor opens a
// version as unsaved changes; saving it makes it the newest version.
export async function GET(request:Request,{params}:{params:Promise<{id:string}>}){
 const user=await currentUser();if(!user)return Response.json({error:"Sign in to edit clips."},{status:401});
 const db=database(),{id}=await params,headers={"Cache-Control":"private, no-store"};
 const want=new URL(request.url).searchParams.get("rev");
 if(want!==null){
  const rev=Number(want);
  if(!Number.isInteger(rev)||rev<0)return Response.json({error:"Choose a version."},{status:400});
  const row=await db.prepare("SELECT rev,edit FROM clip_versions WHERE clip_id=? AND owner=? AND rev=?").bind(id,user.userId,rev).first<{rev:number;edit:string}>();
  if(!row)return Response.json({error:"That version isn't kept any more."},{status:404});
  return Response.json({rev:row.rev,edit:parse(row.edit)},{headers});
 }
 const {results}=await db.prepare("SELECT rev,edit,created_at FROM clip_versions WHERE clip_id=? AND owner=? ORDER BY rev DESC").bind(id,user.userId).all<{rev:number;edit:string;created_at:string}>();
 return Response.json({versions:results.map(r=>({rev:r.rev,createdAt:r.created_at,label:versionLabel(parse(r.edit))}))},{headers});
}
