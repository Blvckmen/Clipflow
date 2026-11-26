import { bucket,database } from "../../../../../../db/raw";
import { workerOwner } from "../../../../../../lib/worker-auth";
import { recordingSourceKey } from "../../../../../../lib/recording-upload";
import { serveClip } from "../../../../../../lib/serve-clip";
export async function GET(request:Request,{params}:{params:Promise<{id:string}>}){
 const db=database(),owner=await workerOwner(request,db);if(!owner)return new Response("Invalid worker token.",{status:401});
 const {id}=await params;
 const row=await db.prepare("SELECT u.id FROM recording_uploads u JOIN recordings r ON r.id=u.id AND r.owner=u.owner WHERE u.id=? AND u.owner=? AND u.complete=1").bind(id,owner).first();
 if(!row)return new Response("Uploaded video not found.",{status:404});
 const store=bucket();if(!store)return new Response("Storage unavailable.",{status:503});
 return serveClip(store,recordingSourceKey(id),request,{cache:"private, no-store",contentType:"application/octet-stream"});
}
