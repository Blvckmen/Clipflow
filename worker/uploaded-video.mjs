import { videoContainer } from "./upload-format.mjs";
import { createWriteStream } from "node:fs";
import { open, rm } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";
import { toRecording } from "./vod.mjs";
export async function downloadUpload(id,dir,api,signal){
 if(!/^[0-9a-f-]{36}$/i.test(id))throw new Error("Invalid uploaded video id");
 const response=await api("/api/worker/recordings/"+id+"/source",{signal,timeout:2*3600_000});
 if(!response.ok||!response.body)throw new Error("Uploaded video unavailable (HTTP "+response.status+")");
 const expected=Number(response.headers.get("content-length"));
 if(!Number.isSafeInteger(expected)||expected<1||expected>2*1024**3){await response.body.cancel();throw new Error("Invalid uploaded video size");}
 let bytes=0;const input=join(dir,"uploaded-video.bin");
 try{
  await pipeline(Readable.fromWeb(response.body),new Transform({transform(chunk,_encoding,done){bytes+=chunk.length;done(bytes>expected?new Error("Uploaded video exceeds declared size"):null,chunk);}}),createWriteStream(input),{signal});
  if(bytes!==expected)throw new Error("Uploaded video download was incomplete");
  const handle=await open(input,"r");
  try{const header=Buffer.alloc(12);await handle.read(header,0,12,0);if(!videoContainer(header))throw new Error("Unsupported uploaded video container");}finally{await handle.close();}
  await toRecording(input,join(dir,"recording.mp4"),{signal});
 }finally{await rm(input,{force:true});}
}
