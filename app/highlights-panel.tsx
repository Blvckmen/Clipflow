"use client";
import { useState } from "react";
import { Download, Film, Loader2, Play, Sparkles, Trash2 } from "lucide-react";

export type Highlight = { id: string; title: string; state: "queued" | "ready" | "failed"; size: number | null; duration: number | null; error: string | null; auto: number; clips: number; created_at: string };
type Mutate = (body: unknown) => Promise<unknown>;

const minutes = (s: number | null) => s == null ? "" : s >= 60 ? Math.floor(s / 60) + "m " + Math.round(s % 60) + "s" : Math.round(s) + "s";

// Clip library -> Highlight videos: the period's best accepted clips joined into one 16:9 video for YouTube, made on the
// worker PC (lib/highlights.ts, worker/highlights-video.mjs). Made here on request, or every Monday (Settings).
export function HighlightsPanel({ highlights, streamers, busy, workerOnline, weekly, mutate }: { highlights: Highlight[]; streamers: { id: string; name: string }[]; busy: boolean; workerOnline: boolean; weekly: boolean; mutate: Mutate }) {
  const [streamerId, setStreamerId] = useState(""), [days, setDays] = useState(7), [count, setCount] = useState(8), [playing, setPlaying] = useState<string | null>(null), [confirm, setConfirm] = useState<string | null>(null);
  return <section className="panel highlights-panel">
    <div className="panel-heading"><div><h2>Highlight videos</h2><p>The best accepted clips of a week, joined into one landscape video for YouTube{weekly ? ". Made every Monday for the past week." : "."}</p></div><Film size={20} /></div>
    <div className="form-body">
      <form className="highlight-form" onSubmit={e => { e.preventDefault(); void mutate({ action: "makeHighlights", days, count, streamerId: streamerId || null }); }}>
        <label>Streamer<select value={streamerId} onChange={e => setStreamerId(e.target.value)}><option value="">All streamers</option>{streamers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label>From<select value={days} onChange={e => setDays(Number(e.target.value))}><option value={7}>The last 7 days</option><option value={14}>The last 14 days</option><option value={30}>The last 30 days</option></select></label>
        <label>Clips<select value={count} onChange={e => setCount(Number(e.target.value))}>{[5, 8, 12, 20].map(n => <option key={n} value={n}>Up to {n}</option>)}</select></label>
        <button type="submit" className="primary" disabled={busy}><Sparkles size={15} />Make highlight video</button>
      </form>
      <small className="field-note">Most viewed first where the platforms report views, then the newest, shown in the order they happened. Each clip is cut from its original footage at its trimmed length, with a short fade between clips.{workerOnline ? "" : " Your worker PC is offline, so it'll be made when it's back."}</small>
      {highlights.length > 0 && <div className="highlight-list">{highlights.map(h => <div key={h.id} className="highlight-row">
        <div className="highlight-info"><strong>{h.title}</strong><small className="muted">{h.clips} clips{h.duration ? " · " + minutes(h.duration) : ""}{h.size ? " · " + (h.size / 1e6).toFixed(0) + " MB" : ""}{h.auto ? " · made automatically" : ""}</small>
          {h.state === "failed" && <small className="engine-error">Couldn&apos;t be made: {h.error ?? "unknown error"}</small>}</div>
        <div className="row-actions">
          {h.state === "queued" && <span className="tag amber"><Loader2 size={11} className="spin" />&nbsp;Being made on your worker PC</span>}
          {h.state === "ready" && <><button type="button" className="secondary" onClick={() => setPlaying(playing === h.id ? null : h.id)}><Play size={14} />{playing === h.id ? "Hide" : "Watch"}</button>
            <a className="secondary" href={"/api/highlights/" + h.id + "?download=1"}><Download size={14} />Download</a></>}
          {confirm === h.id ? <><button type="button" className="secondary" onClick={() => setConfirm(null)}>Keep</button><button type="button" className="danger" disabled={busy} onClick={() => { setConfirm(null); void mutate({ action: "deleteHighlight", id: h.id }); }}>Delete</button></>
            : <button type="button" className="icon-button" aria-label={"Delete " + h.title} title="Delete" onClick={() => setConfirm(h.id)}><Trash2 size={15} /></button>}
        </div>
        {playing === h.id && <video className="highlight-video" src={"/api/highlights/" + h.id} controls autoPlay playsInline />}
      </div>)}</div>}
    </div>
  </section>;
}
