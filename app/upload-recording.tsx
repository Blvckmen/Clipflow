"use client";
import { useEffect,useRef,useState } from "react";
import { Upload,Loader2 } from "lucide-react";
type Props={streamers:{id:string;name:string}[];storage:boolean;workerOnline:boolean;onUploaded:()=>void};
export function UploadRecording({streamers,storage,workerOnline,onUploaded}:Props){
 const [file,setFile]=useState<File|null>(null),[channel,setChannel]=useState(""),[count,setCount]=useState(5),[progress,setProgress]=useState<number|null>(null),[error,setError]=useState(""),[message,setMessage]=useState("");
 const input=useRef<HTMLInputElement>(null),controller=useRef<AbortController|null>(null),session=useRef<string|null>(null);
 const uploading=progress!==null;
 useEffect(()=>()=>{controller.current?.abort();},[]);
 async function json<T={ok:boolean}>(url:string,init:RequestInit):Promise<T>{const r=await fetch(url,init);const body=await r.json().catch(()=>null) as {error?:string}|null;if(!r.ok)throw new Error(body?.error??"Upload failed. Check your connection and try again.");return body as T;}
 async function cancelSession(){const id=session.current;if(!id)return;await json("/api/recording-uploads/"+id,{method:"DELETE"});session.current=null;}
 async function upload(){
  if(!file)return;
  const selected=channel||streamers[0]?.id;if(!selected)return;
  if(!/\.(mp4|mov|mkv|webm)$/i.test(file.name)||file.size<1||file.size>2*1024**3){setError("Choose an MP4, MOV, MKV or WebM video up to 2 GB.");return;}
  setError("");setMessage("");setProgress(0);const abort=new AbortController();controller.current=abort;
  try{
   if(session.current)await cancelSession();
   const created=await json<{id:string;partSize:number}>("/api/recording-uploads",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:file.name,size:file.size,streamerId:selected,count}),signal:abort.signal});
   session.current=created.id;
   for(let offset=0,part=1;offset<file.size;offset+=created.partSize,part++){
    const slice=file.slice(offset,Math.min(file.size,offset+created.partSize));
    let done=false;
    for(let attempt=0;attempt<3&&!done;attempt++){
     try{await json("/api/recording-uploads/"+created.id,{method:"PUT",headers:{"content-type":"application/octet-stream","x-part":String(part)},body:slice,signal:abort.signal});done=true;}
     catch(e){if(abort.signal.aborted||attempt===2)throw e;}
    }
    setProgress(Math.round(100*Math.min(file.size,offset+slice.size)/file.size));
   }
   await json("/api/recording-uploads/"+created.id,{method:"POST",signal:abort.signal});
   session.current=null;setFile(null);if(input.current)input.current.value="";
   setMessage("Upload complete. "+(workerOnline?"Your worker will prepare the recording and requested clips.":"It will be processed when your worker is online."));onUploaded();
  }catch(e){
   setError(abort.signal.aborted?"Upload cancelled.":(e as Error).message);
   try{await cancelSession();}catch{setError("Could not confirm the upload status. Refresh Recordings before trying again; unfinished uploads expire after 24 hours.");onUploaded();}
  }finally{controller.current=null;setProgress(null);}
 }
 return <form className="import-video upload-recording" onSubmit={e=>{e.preventDefault();void upload();}}>
  <label className="field-label" htmlFor="recording-file"><Upload size={14}/> Upload a video from your device</label>
  <input ref={input} id="recording-file" type="file" accept=".mp4,.mov,.mkv,.webm" disabled={uploading||!storage||!streamers.length} onChange={e=>{setFile(e.target.files?.[0]??null);setError("");setMessage("");}}/>
  <small className="muted">MP4, MOV, MKV or WebM, up to 2 GB. Keep this page open until upload completes. Videos are processed on your worker PC.</small>
  {!storage&&<p className="subtle-note">Video storage must be enabled before you can upload files.</p>}
  {!streamers.length&&<p className="subtle-note">Add a channel first to choose the style and posting accounts for your clips.</p>}
  <div className="import-video-row">
   <select aria-label="Channel for uploaded video" value={channel||streamers[0]?.id||""} disabled={uploading||!streamers.length} onChange={e=>setChannel(e.target.value)}>{streamers.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select>
   <select aria-label="Clips from uploaded video" value={count} disabled={uploading} onChange={e=>setCount(Number(e.target.value))}><option value={0}>Just import</option>{[3,5,8,10].map(n=><option key={n} value={n}>Best {n} moments</option>)}</select>
   <button className="primary" disabled={uploading||!file||!storage||!streamers.length}>{uploading?<Loader2 size={15} className="spin"/>:<Upload size={15}/>}Upload video</button>
   {uploading&&<button type="button" className="secondary" onClick={()=>controller.current?.abort()}>Cancel</button>}
  </div>
  {uploading&&<div role="status"><progress aria-label="Video upload progress" value={progress} max={100}/><span> {progress===100?"Finalising upload…":progress+"% uploaded"}</span></div>}
  {error&&<p className="error" role="alert">{error}</p>}{message&&<p className="subtle-note" role="status">{message}</p>}
 </form>;
}
