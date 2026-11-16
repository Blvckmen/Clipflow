"use client";
import { useEffect, useRef, useState } from "react";
import { Clock3, Film, Loader2, Radio, Scissors, Sparkles, Trash2 } from "lucide-react";
export type Recording = { id: string; streamer_id: string; streamer: string | null; title: string | null; started_at: string; ended_at: string | null; duration: number | null; size: number | null; state: "recording" | "processing" | "ready" | "failed"; error: string | null; preview: boolean; uploading: boolean; expires_at: string };
export type RecordingRequest = { id: string; recording_id: string; kind: "moment" | "best"; start: number | null; end: number | null; count: number | null; state: "queued" | "working" | "done" | "failed"; error: string | null; clips: number; created_at: string };
type Signals = { step: number; energy: number[]; chat: number[] };
type Mutate = (body: unknown) => Promise<false | { message: string }>;

// h:mm:ss (or m:ss) for times into a recording.
export const clock = (seconds: number) => {
  const s = Math.max(0, Math.floor(seconds)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return (h ? h + ":" + String(m).padStart(2, "0") : String(m)) + ":" + String(r).padStart(2, "0");
};
const parseClock = (text: string) => {
  const parts = text.trim().split(":").map(Number);
  if (!parts.length || parts.some(n => !Number.isFinite(n) || n < 0)) return null;
  return parts.reduce((total, n) => total * 60 + n, 0);
};
const length = (seconds: number | null) => seconds == null ? "" : seconds >= 3600 ? Math.floor(seconds / 3600) + "h " + Math.round((seconds % 3600) / 60) + "m" : Math.max(1, Math.round(seconds / 60)) + " min";
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

function StateTag({ r }: { r: Recording }) {
  if (r.state === "recording") return <span className="tag lime"><Radio size={11} />&nbsp;Recording now</span>;
  if (r.state === "processing") return <span className="tag amber">Saving on the worker PC</span>;
  if (r.state === "failed") return <span className="tag" title={r.error ?? ""}>Failed</span>;
  if (!r.preview) return <span className="tag amber">{r.uploading ? "Uploading preview" : "Preparing preview"}</span>;
  return <span className="tag lime">Ready</span>;
}

const requestLabel = (q: RecordingRequest) => q.kind === "moment" ? "Clip " + clock(q.start ?? 0) + "–" + clock(q.end ?? 0) : "Best " + q.count + " moment" + (q.count === 1 ? "" : "s");
const requestState = (q: RecordingRequest) => q.state === "queued" ? "Waiting for the worker PC" : q.state === "working" ? "Making clips" : q.state === "done" ? q.clips + " clip" + (q.clips === 1 ? "" : "s") + " in the library" : "Failed" + (q.error ? ": " + q.error : "");

export function RecordingsView({ recordings, requests, storage, busy, workerOnline, duration, mutate, onRefresh, onOpenLibrary }: {
  recordings: Recording[]; requests: RecordingRequest[]; storage: boolean; busy: boolean; workerOnline: boolean; duration: number;
  mutate: Mutate; onRefresh: () => void; onOpenLibrary: () => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const open = recordings.find(r => r.id === openId) ?? null;
  // While anything is being recorded, saved or clipped, look again every half minute.
  const active = recordings.some(r => r.state === "recording" || r.state === "processing" || (r.state === "ready" && !r.preview)) || requests.some(q => q.state === "queued" || q.state === "working");
  useEffect(() => { if (!active) return; const timer = setInterval(onRefresh, 30_000); return () => clearInterval(timer); }, [active, onRefresh]);
  if (!recordings.length) return <section className="panel"><div className="empty tall"><div className="empty-icon"><Film size={30} /></div><h3>No recordings yet</h3>
    <p>Set a streamer to <strong>Record the whole stream</strong> (or clip live and record) under Streamers → Edit. Their next stream is saved on your worker PC, and you can pick clips from it here.</p></div></section>;
  return <div className="recordings-layout">
    <section className="panel recording-list" aria-label="Recordings">
      <div className="panel-heading"><div><h2>Recordings <span className="count">{recordings.length}</span></h2><p>Whole streams kept on your worker PC</p></div></div>
      {recordings.map(r => { const mine = requests.filter(q => q.recording_id === r.id), made = mine.reduce((a, q) => a + q.clips, 0);
        return <button key={r.id} className={"recording-row" + (r.id === open?.id ? " active" : "")} onClick={() => {
          setOpenId(r.id);
          // On a phone the player is below the list: bring it into view.
          if (window.matchMedia("(max-width: 900px)").matches) requestAnimationFrame(() => document.querySelector(".recording-player")?.scrollIntoView({ behavior: "smooth", block: "start" }));
        }}>
          <div className="recording-row-top"><strong>{r.streamer ?? "Removed streamer"}</strong><StateTag r={r} /></div>
          <small>{when(r.started_at)}{r.duration ? " · " + length(r.duration) : ""}{made ? " · " + made + " clip" + (made === 1 ? "" : "s") + " made" : ""}</small>
          {r.title && <small className="recording-title">{r.title}</small>}
        </button>; })}
      <div className="panel-foot"><span className="small-dot" />Kept until the dates shown, then deleted from the worker PC and here. Change it in Settings.</div>
    </section>
    {open ? <RecordingPlayer key={open.id} r={open} requests={requests.filter(q => q.recording_id === open.id)} storage={storage} busy={busy} workerOnline={workerOnline} duration={duration} mutate={mutate} onOpenLibrary={onOpenLibrary} onDeleted={() => setOpenId(null)} />
      : <section className="panel"><div className="empty tall"><div className="empty-icon"><Scissors size={28} /></div><h3>Choose a recording</h3><p>Watch it, see where chat and the audio got loud, and mark the moments you want as clips.</p></div></section>}
  </div>;
}

function RecordingPlayer({ r, requests, storage, busy, workerOnline, duration, mutate, onOpenLibrary, onDeleted }: {
  r: Recording; requests: RecordingRequest[]; storage: boolean; busy: boolean; workerOnline: boolean; duration: number;
  mutate: Mutate; onOpenLibrary: () => void; onDeleted: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null), strip = useRef<HTMLDivElement>(null);
  const [signals, setSignals] = useState<Signals | null>(null), [at, setAt] = useState(0);
  const [start, setStart] = useState<number | null>(null), [end, setEnd] = useState<number | null>(null);
  const [startText, setStartText] = useState(""), [endText, setEndText] = useState("");
  const [count, setCount] = useState(5), [confirmDelete, setConfirmDelete] = useState(false);
  const total = r.duration ?? 0;
  useEffect(() => {
    if (r.state !== "ready") return;
    let gone = false;
    fetch("/api/recordings/" + r.id).then(res => res.ok ? res.json() : null).then(json => { if (!gone) setSignals((json as { signals: Signals | null } | null)?.signals ?? null); }).catch(() => {});
    return () => { gone = true; };
  }, [r.id, r.state]);
  const seek = (t: number) => { const next = Math.max(0, Math.min(total, t)); setAt(next); if (video.current) video.current.currentTime = next; };
  const timeAt = (clientX: number) => { const box = strip.current!.getBoundingClientRect(); return ((clientX - box.left) / box.width) * total; };
  const pct = (t: number) => (total ? (t / total) * 100 : 0) + "%";
  const setFrom = (t: number) => { const v = Math.round(t); setStart(v); setStartText(clock(v)); if (end == null || end <= v || end - v > 90) { const e = Math.min(total || v + duration, v + duration); setEnd(e); setEndText(clock(e)); } };
  const setTo = (t: number) => { const v = Math.round(t); setEnd(v); setEndText(clock(v)); if (start == null || start >= v || v - start > 90) { const s = Math.max(0, v - duration); setStart(s); setStartText(clock(s)); } };
  const len = start != null && end != null ? end - start : 0, valid = len >= 15 && len <= 90;
  const maxChat = Math.max(1, ...(signals?.chat ?? [0]));
  const ready = r.state === "ready";
  return <section className="panel recording-player">
    <div className="panel-heading"><div><h2>{r.streamer ?? "Removed streamer"} · {when(r.started_at)}</h2><p>{r.title ? r.title + " · " : ""}{total ? length(total) : "Still recording"}{r.size ? " · " + (r.size / 1e9).toFixed(1) + " GB on the worker PC" : ""} · kept until {new Date(r.expires_at).toLocaleDateString()}</p></div>
      {r.state !== "recording" && (confirmDelete
        ? <div className="row-actions"><button className="secondary" onClick={() => setConfirmDelete(false)}>Keep</button><button className="danger" disabled={busy} onClick={async () => { if (await mutate({ action: "deleteRecording", id: r.id })) onDeleted(); }}><Trash2 size={14} />Delete recording</button></div>
        : <button className="icon-button" aria-label="Delete recording" title="Delete recording" onClick={() => setConfirmDelete(true)}><Trash2 size={16} /></button>)}</div>
    <div className="form-body">
      {r.state === "recording" && <div className="subtle-note">This stream is being recorded right now. Once it ends, the worker PC saves it{storage ? " and uploads a small preview here so you can watch it" : ""}.</div>}
      {r.state === "processing" && <div className="subtle-note"><Loader2 size={14} className="spin" /> The worker PC is saving this recording. The heat strip and preview appear in a few minutes.</div>}
      {r.state === "failed" && <div className="error" role="status">This recording failed{r.error ? ": " + r.error : "."}</div>}
      {ready && (r.preview
        ? <video ref={video} className="recording-video" controls playsInline preload="metadata" src={"/api/recordings/" + r.id + "/preview"} onTimeUpdate={e => setAt(e.currentTarget.currentTime)} />
        : <div className="subtle-note">{storage ? (r.uploading ? "The preview is uploading from the worker PC." : "The worker PC is making a small preview to watch here. Meanwhile, pick moments from the heat strip below.") : "Clip storage is off on this site, so there is no preview. Pick moments from the heat strip below."}</div>)}
      {ready && total > 0 && <div>
        <div className="heat recording-heat" ref={strip} onPointerDown={e => seek(timeAt(e.clientX))} title="Click to jump there">
          <div className="heat-bars" aria-hidden>{(signals?.energy ?? []).map((e, i) => { const ch = (signals?.chat[i] ?? 0) / maxChat; return <span key={i} style={{ height: Math.max(4, e * 100) + "%", background: ch > 0.05 ? `color-mix(in srgb, #ff7a59 ${Math.round(ch * 100)}%, #4b5a6b)` : undefined }} />; })}</div>
          {start != null && end != null && <div className="heat-range" style={{ left: pct(start), width: pct(Math.max(1, end - start)) }} />}
          <div className="heat-cursor" style={{ left: pct(at) }} />
        </div>
        <div className="heat-legend"><span><i className="loud" />Loudness</span>{signals?.chat.some(c => c > 0) && <span><i className="chat" />Chat activity</span>}<span className="muted">At {clock(at)} of {clock(total)}</span></div>
      </div>}
      {ready && <div className="moment-picker">
        <div className="moment-fields">
          <label>Start<input value={startText} placeholder="0:00" onChange={e => { setStartText(e.target.value); const v = parseClock(e.target.value); setStart(v); }} /></label>
          <button type="button" className="secondary" onClick={() => setFrom(at)}>Start here</button>
          <label>End<input value={endText} placeholder={clock(duration)} onChange={e => { setEndText(e.target.value); const v = parseClock(e.target.value); setEnd(v); }} /></label>
          <button type="button" className="secondary" onClick={() => setTo(at)}>End here</button>
        </div>
        <div className="moment-actions">
          <small className={len && !valid ? "engine-error" : "muted"}>{len ? len + " seconds" + (valid ? "" : " · clips are 15 to 90 seconds") : "Move to a moment, then press Start here (the end is set " + duration + "s later)."}</small>
          {start != null && <button type="button" className="text-button" onClick={() => seek(start)}>Play from start</button>}
          <button className="primary" disabled={busy || !valid || (total > 0 && (start ?? 0) >= total)} onClick={async () => { if (await mutate({ action: "makeClip", recordingId: r.id, start, end })) { setStart(null); setEnd(null); setStartText(""); setEndText(""); } }}><Scissors size={15} />Make clip</button>
        </div>
      </div>}
      {r.state !== "failed" && <div className="best-moments"><Sparkles size={18} /><div><strong>Let Clipflow choose</strong><small>Finds the loudest, busiest moments{signals?.chat.some(c => c > 0) ? " (audio and chat)" : ""} and makes {duration}s clips of them.</small></div>
        <select aria-label="How many clips" value={count} onChange={e => setCount(Number(e.target.value))}>{[1, 3, 5, 8, 10].map(n => <option key={n} value={n}>{n} clip{n === 1 ? "" : "s"}</option>)}</select>
        <button className="secondary" disabled={busy} onClick={() => void mutate({ action: "findMoments", recordingId: r.id, count })}>Find best moments</button></div>}
      {!workerOnline && r.state !== "failed" && <div className="subtle-note">Your worker PC is offline. Clips are made from the full-quality recording on it, so requests wait until it is back.</div>}
      {requests.length > 0 && <div><span className="field-label">Clips asked for</span><div className="request-list">{requests.map(q => <div key={q.id} className="request-row">
        <span>{q.kind === "moment" ? <Scissors size={13} /> : <Sparkles size={13} />}{requestLabel(q)}</span>
        <span className={"tag " + (q.state === "done" ? "lime" : q.state === "failed" ? "" : "amber")} title={q.error ?? ""}>{q.state === "working" && <Loader2 size={11} className="spin" />}&nbsp;{requestState(q)}</span>
        {q.kind === "moment" && q.start != null && r.preview && <button className="text-button" onClick={() => seek(q.start!)}><Clock3 size={12} />Watch</button>}
        {q.state === "done" && <button className="text-button" onClick={onOpenLibrary}>Open library</button>}
      </div>)}</div></div>}
    </div>
  </section>;
}
