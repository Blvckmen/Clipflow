import { currentUser } from "../../../../auth";
import { database } from "../../../../../db/raw";
import { timeline } from "../../../../../worker/edit.mjs";
import { SUBTITLE_FORMATS, subtitleFile } from "../../../../../worker/transcript.mjs";
export const dynamic="force-dynamic";
const parse=(json:string|null)=>{try{return json?JSON.parse(json):null;}catch{return null;}};
// A clip's subtitles or transcript as a file, from its saved edit: GET ?format=srt|vtt|txt. The lines and times are
// the finished clip's (after jump cuts), as burned into the video; the transcript has speaker names and timestamps.
export async function GET(request:Request,{params}:{params:Promise<{id:string}>}){
 const user=await currentUser();if(!user)return Response.json({error:"Sign in to download subtitles."},{status:401});
 const format=new URL(request.url).searchParams.get("format")??"srt";
 if(!(format in SUBTITLE_FORMATS))return Response.json({error:"Choose srt, vtt or txt."},{status:400});
 const {id}=await params;
 const clip=await database().prepare("SELECT c.edit,c.transcript,c.signals,c.created_at,s.name AS streamer FROM clips c LEFT JOIN streamers s ON s.id=c.streamer_id AND s.owner=c.owner WHERE c.id=? AND c.owner=?").bind(id,user.userId).first<{edit:string|null;transcript:string|null;signals:string|null;created_at:string;streamer:string|null}>();
 if(!clip)return Response.json({error:"Clip not found."},{status:404});
 const edit=parse(clip.edit);
 if(!edit)return Response.json({error:"This clip has no edit yet, so there are no subtitles to download."},{status:409});
 const words=parse(clip.transcript)??[],energy=parse(clip.signals)?.energy??null;
 let file;
 try{file=subtitleFile(format,edit,words,timeline(edit,edit.words??words,energy));}
 catch(error){console.error("Subtitle file failed",error);return Response.json({error:"Couldn't make the subtitle file."},{status:500});}
 const name=((clip.streamer??"clip").replace(/[^\p{L}\p{N}_-]+/gu,"-").slice(0,40)||"clip")+"-"+clip.created_at.slice(0,10)+"."+file.ext;
 return new Response(file.body,{headers:{"Content-Type":file.type,"Content-Disposition":`attachment; filename="${name}"`,"Cache-Control":"private, no-store"}});
}
