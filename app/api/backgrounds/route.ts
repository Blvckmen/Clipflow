import { currentUser } from "../../auth";
import { bucket, database } from "../../../db/raw";
export const dynamic="force-dynamic";
// The workspace's split-screen background videos. Upload: POST the MP4 as the request body, its name in
// x-file-name. Cloudflare takes request bodies up to 100 MB, so files are capped a little below that.
const MAX_BACKGROUND_BYTES=95*1024*1024, MAX_BACKGROUNDS=20;
const list=(owner:string)=>database().prepare("SELECT id,name,size,created_at FROM backgrounds WHERE owner=? ORDER BY created_at").bind(owner).all();
export async function GET(){
 const user=await currentUser();if(!user)return Response.json({error:"Sign in first."},{status:401});
 return Response.json({backgrounds:(await list(user.userId)).results},{headers:{"Cache-Control":"private, no-store"}});
}
export async function POST(request:Request){
 const user=await currentUser();if(!user)return Response.json({error:"Sign in first."},{status:401});
 const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)return Response.json({error:"Request origin rejected."},{status:403});
 const store=bucket();if(!store)return Response.json({error:"Clip storage (R2) is off on this site, so videos can't be uploaded."},{status:501});
 const size=Number(request.headers.get("content-length")??NaN),type=(request.headers.get("content-type")??"").split(";")[0].trim().toLowerCase();
 if(type!=="video/mp4")return Response.json({error:"Upload an MP4 video."},{status:415});
 if(!Number.isFinite(size)||size<1024)return Response.json({error:"That file is empty."},{status:400});
 if(size>MAX_BACKGROUND_BYTES)return Response.json({error:"Background videos can be up to 95 MB. A 30–60 second loop at 720p is plenty."},{status:413});
 const db=database(),owner=user.userId;
 const count=await db.prepare("SELECT count(*) AS n FROM backgrounds WHERE owner=?").bind(owner).first<{n:number}>();
 if((count?.n??0)>=MAX_BACKGROUNDS)return Response.json({error:"The library holds up to "+MAX_BACKGROUNDS+" videos; delete one first."},{status:409});
 const name=(decodeURIComponent(request.headers.get("x-file-name")??"")||"Background").replace(/\.mp4$/i,"").replace(/[^\p{L}\p{N} ._()-]/gu,"").trim().slice(0,80)||"Background";
 const id=crypto.randomUUID(),key="backgrounds/"+id+".mp4";
 // Stream straight into R2; the declared length is checked against what arrives.
 const stored=await store.put(key,request.body,{httpMetadata:{contentType:"video/mp4"}});
 if(!stored||stored.size!==size){await store.delete(key);return Response.json({error:"The upload was incomplete. Please try again."},{status:400});}
 const iso=new Date().toISOString();
 await db.batch([
  db.prepare("INSERT INTO backgrounds (id,owner,name,key,size,content_type,created_at) VALUES (?,?,?,?,?,?,?)").bind(id,owner,name,key,size,type,iso),
  db.prepare("INSERT INTO events (id,owner,message,created_at) VALUES (?,?,?,?)").bind(crypto.randomUUID(),owner,"Added background video "+name+" to the split-screen library.",iso),
 ]);
 return Response.json({ok:true,message:"Added "+name+" to your background library.",backgrounds:(await list(owner)).results});
}
