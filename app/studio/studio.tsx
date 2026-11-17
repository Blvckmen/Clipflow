"use client";
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Check, Copy, Loader2, RefreshCw, Sparkles } from "lucide-react";

type Platform="TikTok"|"Instagram"|"YouTube"|"Facebook"|"X";
type Tone="curiosity"|"funny"|"dramatic"|"informative";
type Clip={id:string;duration:number;reason:string|null;streamer:string|null;source:string|null};
type Draft={transcript:string;platform:Platform;tone:Tone;hooks:string[];captions:string[];selectedHook:string;selectedCaption:string;status:"draft"|"approved"};
type Payload={clip:Clip;copy:Draft;aiConfigured:boolean;error?:string};
const blank:Draft={transcript:"",platform:"TikTok",tone:"curiosity",hooks:[],captions:[],selectedHook:"",selectedCaption:"",status:"draft"};
const clipUuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function CopyStudio(){
 const [clips,setClips]=useState<{id:string;streamer:string|null}[]>([]);
 const [id,setId]=useState(""),[clip,setClip]=useState<Clip|null>(null),[copy,setCopy]=useState<Draft>(blank),[ai,setAi]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(""),[message,setMessage]=useState("");
 const fetchClip=useCallback(async(clipId:string)=>{
  if(!clipUuid.test(clipId))return;
  setBusy(true);setError("");setMessage("");
  try{const r=await fetch("/api/clips/"+clipId+"/copy");const p=await r.json() as Payload;if(!r.ok)throw Error(p.error||"Unable to load clip");setClip(p.clip);setCopy(p.copy);setAi(p.aiConfigured);}
  catch(e){setClip(null);setError(e instanceof Error?e.message:"Unable to load clip");}
  finally{setBusy(false);}
 },[]);
 useEffect(()=>{
  const requested=new URLSearchParams(window.location.search).get("clip");
  void fetch("/api/dashboard").then(r=>r.json()).then(p=>{if(Array.isArray(p.clips)){setClips(p.clips);const first=requested||p.clips[0]?.id||"";setId(first);if(first)void fetchClip(first);}else setError("Sign in to open your clip library.");}).catch(()=>setError("Could not load clips."));
 },[fetchClip]);
 const changeClip=(next:string)=>{setId(next);setClip(null);setCopy(blank);window.history.replaceState(null,"","/studio?clip="+encodeURIComponent(next));void fetchClip(next);};
 const save=async(status:"draft"|"approved")=>{
  if(!id)return;
  setBusy(true);setError("");setMessage("");
  try{const r=await fetch("/api/clips/"+id+"/copy",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"save",...copy,status})});const x=await r.json() as {error?:string};if(!r.ok)throw Error(x.error||"Save failed");setCopy(p=>({...p,status}));setMessage(status==="approved"?"Approved. For Instagram, your selected caption will be used when the clip publishes. Hook text is for your export workflow.":"Draft saved.");}
  catch(e){setError(e instanceof Error?e.message:"Save failed");}finally{setBusy(false);}
 };
 const generate=async()=>{
  if(!id||copy.transcript.trim().length<12){setError("Enter a transcript of at least 12 characters to generate accurate hooks.");return;}
  setBusy(true);setError("");setMessage("");
  try{const r=await fetch("/api/clips/"+id+"/copy",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"generate",platform:copy.platform,tone:copy.tone,transcript:copy.transcript})});const x=await r.json() as {error?:string;hooks:string[];captions:string[];selectedHook:string;selectedCaption:string};if(!r.ok)throw Error(x.error||"Generation failed");setCopy(p=>({...p,hooks:x.hooks,captions:x.captions,selectedHook:x.selectedHook,selectedCaption:x.selectedCaption,status:"draft"}));setMessage("Fresh draft generated. Review it before approving.");}
  catch(e){setError(e instanceof Error?e.message:"Generation failed");}finally{setBusy(false);}
 };
 const update=(patch:Partial<Draft>)=>setCopy(p=>({...p,...patch,status:"draft"}));
 return <div style={{minHeight:"100vh",background:"#0c0f13",color:"#eef1f5",padding:"36px max(20px, calc((100vw - 1060px)/2))",fontFamily:"Inter,Segoe UI,Arial,sans-serif"}}>
  <a href="/" style={{color:"#bffa77",display:"inline-flex",alignItems:"center",gap:8,marginBottom:22}}><ArrowLeft size={17}/> Back to ClipFlow</a>
  <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:5}}><Sparkles color="#bffa77"/><h1 style={{margin:0}}>AI Copy Studio</h1></div>
  <p style={{marginBottom:24,color:"#9ca7b4"}}>Create accurate stream hooks and social captions from clip transcripts. All generated copy starts as a draft.</p>
  <section className="panel" style={{padding:24,marginBottom:18}}>
   <label htmlFor="clip-choice" style={{display:"block",marginBottom:8}}>Select clip</label>
   <select id="clip-choice" value={id} onChange={e=>changeClip(e.target.value)} style={{width:"100%",padding:12,background:"#181e25",color:"white",border:"1px solid #39414c",borderRadius:8}}>{!clips.length&&<option value="">No clips yet</option>}{clips.map(c=><option key={c.id} value={c.id}>{c.streamer||"Clip"} · {c.id.slice(0,8)}</option>)}</select>
   {clip&&<p style={{marginTop:12,fontSize:13}}>Source: {clip.streamer||"Unknown"} · {clip.source||"Stream"} · {clip.duration} seconds · {clip.reason||"Highlight"} {copy.status==="approved"?" · Approved":" · Draft"}</p>}
  </section>
  {clip&&<><section className="panel" style={{padding:24,marginBottom:18}}>
   <h2 style={{marginBottom:10}}>1. Clip transcript</h2>
   <p style={{marginBottom:12,fontSize:13}}>Captured automatically from the clip worker when available. Older clips may need their transcript pasted manually. Check accuracy before generating.</p>
   <textarea aria-label="Clip transcript" rows={6} maxLength={6000} value={copy.transcript} onChange={e=>update({transcript:e.target.value})} style={{width:"100%",background:"#171d23",border:"1px solid #39414c",borderRadius:8,color:"white",padding:12,resize:"vertical"}} placeholder="Paste what was said in the clip..."/>
   <div style={{display:"flex",gap:12,flexWrap:"wrap",marginTop:16}}>
    <label>Platform <select value={copy.platform} onChange={e=>update({platform:e.target.value as Platform})}>{["TikTok","Instagram","YouTube","Facebook","X"].map(p=><option key={p}>{p}</option>)}</select></label>
    <label>Style <select value={copy.tone} onChange={e=>update({tone:e.target.value as Tone})}>{["curiosity","funny","dramatic","informative"].map(t=><option key={t}>{t}</option>)}</select></label>
   </div>
   <button className="primary" onClick={()=>void generate()} disabled={busy||!ai||copy.transcript.trim().length<12} style={{marginTop:17}}>{busy?<Loader2 size={16}/>:<Sparkles size={16}/>} Generate hooks & captions</button>
   {!ai&&<p style={{marginTop:10,fontSize:13}}>AI generation is unavailable until OPENAI_API_KEY is configured. You can still write and save copy manually.</p>}
  </section>
  <section className="panel" style={{padding:24,marginBottom:18}}>
   <h2 style={{marginBottom:12}}>2. On-screen hook</h2>
   {copy.hooks.map((h,i)=><button key={i} type="button" className="secondary" onClick={()=>update({selectedHook:h})} style={{marginRight:8,marginBottom:8,borderColor:copy.selectedHook===h?"#bffa77":undefined}}>{h}</button>)}
   <textarea aria-label="Selected hook" rows={2} maxLength={160} placeholder="Write or select an on-screen hook" value={copy.selectedHook} onChange={e=>update({selectedHook:e.target.value})} style={{display:"block",width:"100%",marginTop:10,padding:12,background:"#171d23",color:"white",border:"1px solid #39414c",borderRadius:8}}/>
   <button className="secondary" style={{marginTop:10}} disabled={!copy.selectedHook} onClick={()=>void navigator.clipboard.writeText(copy.selectedHook)}><Copy size={15}/> Copy hook</button>
  </section>
  <section className="panel" style={{padding:24,marginBottom:18}}>
   <h2 style={{marginBottom:12}}>3. Social post caption</h2>
   {copy.captions.map((c,i)=><button key={i} className="secondary" onClick={()=>update({selectedCaption:c})} style={{display:"block",textAlign:"left",whiteSpace:"normal",marginBottom:8,borderColor:copy.selectedCaption===c?"#bffa77":undefined}}>{c}</button>)}
   <textarea aria-label="Selected caption" rows={5} maxLength={2200} placeholder="Write or select the post caption" value={copy.selectedCaption} onChange={e=>update({selectedCaption:e.target.value})} style={{width:"100%",padding:12,background:"#171d23",color:"white",border:"1px solid #39414c",borderRadius:8}}/>
   <button className="secondary" style={{marginTop:10}} disabled={!copy.selectedCaption} onClick={()=>void navigator.clipboard.writeText(copy.selectedCaption)}><Copy size={15}/> Copy caption</button>
  </section>
  <section className="panel" style={{padding:24,marginBottom:18}}>
   <h2 style={{marginBottom:8}}>4. Review & approve</h2><p style={{marginBottom:16}}>Approving Instagram copy replaces the normal caption template for this clip when it publishes. Other platforms are export-only until a publishing integration is available. The hook is not yet burned into the video.</p>
   <div style={{display:"flex",gap:12,flexWrap:"wrap"}}><button className="secondary" disabled={busy} onClick={()=>void save("draft")}><RefreshCw size={16}/> Save draft</button><button className="primary" disabled={busy||!copy.selectedHook.trim()||!copy.selectedCaption.trim()} onClick={()=>void save("approved")}><Check size={16}/> Approve copy</button></div>
  </section></>}
  {error&&<p role="alert" style={{color:"#ff9b9e",marginTop:16}}>{error}</p>}{message&&<p role="status" style={{color:"#bffa77",marginTop:16}}>{message}</p>}
 </div>;
}
