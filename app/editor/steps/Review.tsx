"use client";
// Step 4, Review & post: the finished video as it will be posted, approving it, the post text, and the saved
// versions of this clip's edit.
import { useEffect, useState } from "react";
import { Check, Copy, History, Loader2, ThumbsDown, ThumbsUp } from "lucide-react";
import { readJson } from "../../../lib/read-json.mjs";
import type { Bundle, Edit } from "../types";

type Version = { rev: number; createdAt: string; label: string };
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function Review({ bundle, dirty, onRestore, saveStyle, setSaveStyle, onCopy, copying }: {
  bundle: Bundle; dirty: boolean; onRestore: (edit: Edit, rev: number) => void;
  saveStyle: boolean; setSaveStyle: (v: boolean) => void; onCopy?: () => void; copying: boolean;
}) {
  const rendering = bundle.render.state === "queued", failed = bundle.render.state === "failed";
  const [review, setReview] = useState(bundle.review ?? "pending"), [busy, setBusy] = useState(""), [note, setNote] = useState("");
  const [postText, setPostText] = useState(bundle.caption.text ?? ""), [captionSource, setCaptionSource] = useState(bundle.caption.source), [captionNote, setCaptionNote] = useState(bundle.caption.error ? "Last attempt failed: " + bundle.caption.error : "");
  const [versions, setVersions] = useState<Version[] | null>(null);
  useEffect(() => {
    let live = true;
    fetch("/api/clips/" + bundle.id + "/versions").then(r => readJson<{ versions?: Version[] }>(r)).then(b => { if (live) setVersions(b.versions ?? []); }).catch(() => { if (live) setVersions([]); });
    return () => { live = false; };
  }, [bundle.id]);

  const post = async (body: object) => {
    const response = await fetch("/api/dashboard", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const result = await readJson<{ error?: string; message?: string }>(response);
    if (!response.ok) throw new Error(result.error || "Please retry.");
    return result;
  };
  const decide = async (to: "approved" | "rejected" | "pending") => {
    setBusy(to); setNote("");
    try { const r = await post({ action: "reviewClip", id: bundle.id, review: to }); setReview(to); setNote(r.message ?? ""); }
    catch (e) { setNote((e as Error).message); } finally { setBusy(""); }
  };
  const saveCaption = async () => {
    setBusy("caption"); setCaptionNote("");
    try {
      const response = await fetch("/api/clips/" + bundle.id + "/caption", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "save", text: postText }) });
      const result = await readJson<{ error?: string; text: string | null; source: string | null; message: string }>(response);
      if (!response.ok) throw new Error(result.error);
      setPostText(result.text ?? ""); setCaptionSource(result.source); setCaptionNote(result.message);
    } catch (e) { setCaptionNote(e instanceof Error ? e.message : "Couldn't save the post text."); } finally { setBusy(""); }
  };
  const open = async (rev: number) => {
    setBusy("v" + rev); setNote("");
    try {
      const response = await fetch("/api/clips/" + bundle.id + "/versions?rev=" + rev);
      const result = await readJson<{ error?: string; edit?: Edit }>(response);
      if (!response.ok || !result.edit) throw new Error(result.error || "Couldn't open that version.");
      onRestore(result.edit, rev);
    } catch (e) { setNote((e as Error).message); } finally { setBusy(""); }
  };
  // Approving is for the video on screen: not while there are unsaved changes or a render on the way.
  const locked = dirty || rendering, state = dirty ? "Not saved yet: Save & render to see your changes here." : rendering ? "Rendering your latest save…" : failed ? "The last render failed: " + (bundle.render.error ?? "unknown error") + ". Save again to retry." : "Up to date.";

  return <>
    <div className="review-video">
      {bundle.render.at || !rendering ? <video key={bundle.rev} src={"/api/clips/" + bundle.id + "/file?v=" + bundle.rev} controls playsInline preload="metadata" /> : <div className="review-empty"><Loader2 className="spin" size={18} /></div>}
      <p className={"review-state" + (locked || failed ? " warn" : "")} role="status">{state}</p>
    </div>
    <div className="review-actions">
      <button className={"secondary" + (review === "approved" ? " chosen" : "")} disabled={locked || !!busy} onClick={() => void decide(review === "approved" ? "pending" : "approved")}>{busy === "approved" ? <Loader2 className="spin" size={15} /> : <ThumbsUp size={15} />}{review === "approved" ? "Approved" : "Approve"}</button>
      <button className={"secondary" + (review === "rejected" ? " chosen" : "")} disabled={locked || !!busy} onClick={() => void decide(review === "rejected" ? "pending" : "rejected")}>{busy === "rejected" ? <Loader2 className="spin" size={15} /> : <ThumbsDown size={15} />}{review === "rejected" ? "Rejected" : "Reject"}</button>
      {note && <span className="hint" role="status">{note}</span>}
    </div>
    <label className="wide">Post text <small>{captionSource === "local" ? "From the transcript" : captionSource === "ai" ? "Written by the AI writer" : captionSource === "edited" ? "Your text" : bundle.caption.ai ? "Written before posting" : "The template is used"}</small>
      <textarea rows={6} maxLength={2200} value={postText} onChange={e => setPostText(e.target.value)} placeholder={bundle.caption.ai ? "Leave empty for automatic post text" : "Type the text to post with this clip"} /></label>
    <div className="caption-actions"><span className="muted">{postText.length} / 2200 · the first line is the YouTube title</span>
      <button className="primary" disabled={!!busy} onClick={() => void saveCaption()}>{busy === "caption" ? <Loader2 className="spin" size={15} /> : <Check size={15} />}Save post text</button></div>
    {captionNote && <p className="hint" role="status">{captionNote}</p>}
    <div className="versions">
      <h3><History size={15} />Versions</h3>
      {versions === null ? <p className="muted">Loading…</p> : versions.length === 0 ? <p className="muted">Each save is kept here.</p>
        : <ol>{versions.map((v, i) => <li key={v.rev}><span><strong>{i === 0 ? "Latest" : when(v.createdAt)}</strong><small>{v.label}</small></span>
          {v.rev === bundle.rev ? <span className="muted">Saved now</span> : <button type="button" className="text-button" disabled={!!busy} onClick={() => void open(v.rev)}>{busy === "v" + v.rev ? "Opening…" : "Open"}</button>}</li>)}</ol>}
    </div>
    <div className="review-more">
      <label className="editor-check"><input type="checkbox" checked={saveStyle} onChange={e => setSaveStyle(e.target.checked)} />Use this look for {bundle.streamer ?? "this streamer"}&apos;s new clips</label>
      {onCopy && <button className="secondary" disabled={copying || dirty} title={dirty ? "Save or discard your changes first" : "A second clip from the same footage"} onClick={onCopy}>{copying ? <Loader2 className="spin" size={16} /> : <Copy size={16} />}Make a copy</button>}
    </div>
  </>;
}
