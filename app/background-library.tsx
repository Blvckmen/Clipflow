"use client";
// Settings → Split-screen backgrounds: looping videos or still images shown under the stream in split screen.
import { useEffect, useRef, useState } from "react";
import { Film, Loader2, Trash2, Upload } from "lucide-react";

export type Background = { id: string; name: string; size: number; duration?: number | null; content_type?: string; created_at: string };
const IMAGE_TYPES: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };
const isImage = (b: Background) => !!b.content_type?.startsWith("image/");

// A video file's length in seconds, read by the browser (null if it can't be read).
export function videoLength(src: string): Promise<number | null> {
  return new Promise(resolve => {
    const v = document.createElement("video"); v.preload = "metadata"; v.muted = true;
    const done = (n: number | null) => { v.removeAttribute("src"); v.load(); resolve(n); };
    v.onloadedmetadata = () => done(Number.isFinite(v.duration) && v.duration > 0 ? v.duration : null);
    v.onerror = () => done(null);
    setTimeout(() => done(null), 20_000);
    v.src = src;
  });
}

export function BackgroundLibrary({ backgrounds, storage, busy, onUploaded, onDelete }: {
  backgrounds: Background[]; storage: boolean; busy: boolean; onUploaded: (message: string) => void; onDelete: (id: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(""), [error, setError] = useState("");
  const mb = (n: number) => (n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0) + " MB";
  const secs = (n?: number | null) => n ? (n >= 60 ? Math.floor(n / 60) + ":" + String(Math.round(n % 60)).padStart(2, "0") : Math.round(n) + "s") : null;
  // Videos uploaded before lengths were recorded: measure them here once, so the editor can match them to clips.
  useEffect(() => {
    for (const b of backgrounds) if (!b.duration && !isImage(b)) void videoLength("/api/backgrounds/" + b.id + "/file").then(d => {
      if (d) void fetch("/api/dashboard", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "backgroundLength", id: b.id, duration: d }) });
    });
  }, [backgrounds]);
  const upload = async (file: File) => {
    setError("");
    const ext = file.name.toLowerCase().split(".").pop() ?? "", type = IMAGE_TYPES[ext] ?? (file.type === "video/mp4" || ext === "mp4" ? "video/mp4" : "");
    if (!type) return setError("Upload an MP4 video or a JPEG, PNG or WebP image.");
    const image = type.startsWith("image/");
    if (image && file.size > 15 * 1024 * 1024) return setError("Background images can be up to 15 MB.");
    if (file.size > 95 * 1024 * 1024) return setError("Background videos can be up to 95 MB. A 30–60 second loop at 720p is plenty.");
    setUploading(file.name);
    try {
      let seconds: number | null = null;
      if (!image) { const url = URL.createObjectURL(file); seconds = await videoLength(url); URL.revokeObjectURL(url); }
      const response = await fetch("/api/backgrounds", { method: "POST", headers: { "content-type": type, "x-file-name": encodeURIComponent(file.name), ...(seconds && { "x-duration": String(seconds) }) }, body: file });
      const result = await response.json() as { message?: string; error?: string };
      if (!response.ok) throw new Error(result.error ?? "Upload failed.");
      onUploaded(result.message ?? "Uploaded.");
    } catch (e) { setError(e instanceof Error ? e.message : "Upload failed."); }
    finally { setUploading(""); if (input.current) input.current.value = ""; }
  };
  return <section className="panel settings-panel background-library">
    <div className="panel-heading"><div><h2>Split-screen backgrounds <span className="count">{backgrounds.length}</span></h2><p>Videos or images shown under the stream when a clip uses split screen. Each clip gets one that fits (a video at least as long as the clip, or any image), or the one you pick in the editor, where your other clips can be picked too.</p></div>
      <button className="primary" type="button" disabled={!storage || busy || !!uploading} onClick={() => input.current?.click()}>{uploading ? <Loader2 size={15} className="spin" /> : <Upload size={15} />}{uploading ? "Uploading…" : "Upload video or image"}</button>
      <input ref={input} type="file" accept="video/mp4,.mp4,image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" hidden onChange={e => { const f = e.target.files?.[0]; if (f) void upload(f); }} /></div>
    {error && <div className="error" role="alert">{error}</div>}
    {uploading && <div className="subtle-note">Uploading {uploading}. Keep this tab open until it finishes.</div>}
    {!storage ? <div className="empty"><p>Clip storage (R2) is off on this site, so backgrounds can&apos;t be stored.</p></div>
      : backgrounds.length ? <div className="background-grid">{backgrounds.map(b => <figure key={b.id} className="background-item">
        {isImage(b) ? <img src={"/api/backgrounds/" + b.id + "/file"} alt={b.name} loading="lazy" />
          : <video src={"/api/backgrounds/" + b.id + "/file#t=1"} muted loop playsInline preload="metadata" onMouseEnter={e => void e.currentTarget.play().catch(() => {})} onMouseLeave={e => e.currentTarget.pause()} />}
        <figcaption><span title={b.name}>{b.name}</span><small>{[isImage(b) ? "Image" : secs(b.duration), mb(b.size)].filter(Boolean).join(" · ")}</small></figcaption>
        <button className="icon-button" type="button" aria-label={"Delete " + b.name} title="Delete" disabled={busy} onClick={() => onDelete(b.id)}><Trash2 size={14} /></button>
      </figure>)}</div>
      : <div className="empty"><div className="empty-icon"><Film size={26} /></div><p>No backgrounds yet. Upload MP4 loops or images you have the rights to use: your own gameplay or artwork, or royalty-free footage and photos from sites like Pexels or Pixabay.</p></div>}
    <div className="panel-foot"><span className="small-dot" />Use footage you own or that is licensed for reuse; platforms can limit reach for reused videos they recognise.</div>
  </section>;
}
