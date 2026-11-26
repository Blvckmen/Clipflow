import { bucket, database } from "../db/raw";
export const UPLOAD_PART_BYTES=16*1024*1024;
export const MAX_UPLOAD_BYTES=2*1024*1024*1024;
export const recordingSourceKey=(id:string)=>"recording-sources/"+id;
export type UploadRow={id:string;owner:string;streamer_id:string;name:string;size:number;clip_count:number;upload_id:string|null;parts:string;complete:number;created_at:string};
export function validVideoName(name:string){return /\.(mp4|mov|mkv|webm)$/i.test(name);}
export async function discardUpload(id:string,store=bucket(),db=database()){
 const row=await db.prepare("SELECT upload_id FROM recording_uploads WHERE id=?").bind(id).first<{upload_id:string|null}>();
 if(store){
  if(row?.upload_id)await store.resumeMultipartUpload(recordingSourceKey(id),row.upload_id).abort().catch(()=>{});
  await store.delete(recordingSourceKey(id));
 }
 await db.prepare("DELETE FROM recording_uploads WHERE id=?").bind(id).run();
}
