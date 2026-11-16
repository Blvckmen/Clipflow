"use client";
// Settings → Split-screen backgrounds: the looping videos shown under the stream when a clip uses split screen.
import { useRef, useState } from "react";
import { Film, Loader2, Trash2, Upload } from "lucide-react";

export type Background = { id: string; name: string; size: number; created_at: string };

export function BackgroundLibrary({ backgrounds, storage, busy, onUploaded, onDelete }: {
  backgrounds: Background[]; storage: boolean; busy: boolean; onUploaded: (message: string) => void; onDelete: (id: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(""), [error, setError] = useState("");
  const mb = (n: number) => (n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0) + " MB";
  const upload = async (file: File) => {
    setError("");
    if (file.type !== "video/mp4" && !file.name.toLowerCase().endsWith(".mp4")) return setError("Upload an MP4 video.");
    if (file.size > 95 * 1024 * 1024) return setError("Background videos can be up to 95 MB. A 30–60 second loop at 720p is plenty.");
    setUploading(file.name);
    try {
      const response = await fetch("/api/backgrounds", { method: "POST", headers: { "content-type": "video/mp4", "x-file-name": encodeURIComponent(file.name) }, body: file });
      const result = await response.json() as { message?: string; error?: string };
      if (!response.ok) throw new Error(result.error ?? "Upload failed.");
      onUploaded(result.message ?? "Uploaded.");
    } catch (e) { setError(e instanceof Error ? e.message : "Upload failed."); }
    finally { setUploading(""); if (input.current) input.current.value = ""; }
  };
  return <section className="panel settings-panel background-library">
    <div className="panel-heading"><div><h2>Split-screen backgrounds <span className="count">{backgrounds.length}</span></h2><p>Looping videos shown under the stream when a clip uses split screen. Each clip gets one from here, or the one you pick in the editor.</p></div>
      <button className="primary" type="button" disabled={!storage || busy || !!uploading} onClick={() => input.current?.click()}>{uploading ? <Loader2 size={15} className="spin" /> : <Upload size={15} />}{uploading ? "Uploading…" : "Upload video"}</button>
      <input ref={input} type="file" accept="video/mp4,.mp4" hidden onChange={e => { const f = e.target.files?.[0]; if (f) void upload(f); }} /></div>
    {error && <div className="error" role="alert">{error}</div>}
    {uploading && <div className="subtle-note">Uploading {uploading}. Keep this tab open until it finishes.</div>}
    {!storage ? <div className="empty"><p>Clip storage (R2) is off on this site, so background videos can&apos;t be stored.</p></div>
      : backgrounds.length ? <div className="background-grid">{backgrounds.map(b => <figure key={b.id} className="background-item">
        <video src={"/api/backgrounds/" + b.id + "/file#t=1"} muted loop playsInline preload="metadata" onMouseEnter={e => void e.currentTarget.play().catch(() => {})} onMouseLeave={e => e.currentTarget.pause()} />
        <figcaption><span title={b.name}>{b.name}</span><small>{mb(b.size)}</small></figcaption>
        <button className="icon-button" type="button" aria-label={"Delete " + b.name} title="Delete" disabled={busy} onClick={() => onDelete(b.id)}><Trash2 size={14} /></button>
      </figure>)}</div>
      : <div className="empty"><div className="empty-icon"><Film size={26} /></div><p>No background videos yet. Upload MP4 loops you have the rights to use: your own gameplay, or royalty-free footage from sites like Pexels or Pixabay.</p></div>}
    <div className="panel-foot"><span className="small-dot" />Use footage you own or that is licensed for reuse; platforms can limit reach for reused videos they recognise.</div>
  </section>;
}
