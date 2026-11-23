"use client";
import { useEffect, useRef, useState } from "react";
import { Clock3, Download, Film, Link2, Loader2, Radio, Scissors, Search, Sparkles, Trash2 } from "lucide-react";
import { PLATFORM_NAMES, videoLink } from "../worker/video-link.mjs";
// "queued" and "importing": a video pasted below, waiting for the worker PC and then downloading.
export type Recording = { id: string; streamer_id: string; streamer: string | null; title: string | null; started_at: string; ended_at: string | null; duration: number | null; size: number | null; state: "queued" | "importing" | "recording" | "processing" | "ready" | "failed"; error: string | null; preview: boolean; uploading: boolean; expires_at: string; source_url?: string | null; transcript?: boolean };
type StreamerChoice = { id: string; name: string };
const sourceName = (r: Recording) => { const link = r.source_url ? videoLink(r.source_url) as { platform: keyof typeof PLATFORM_NAMES } | null : null; return link ? PLATFORM_NAMES[link.platform] : null; };
export type RecordingRequest = { id: string; recording_id: string; kind: "moment" | "best"; start: number | null; end: number | null; count: number | null; state: "queued" | "working" | "done" | "failed"; error: string | null; clips: number; created_at: string };
type Moment = { start: number; end: number; score: number; why: string[] };
type Signals = { step: number; energy: number[]; chat: number[]; moments?: Moment[] };
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
  if (r.state === "queued") return <span className="tag amber">Waiting for the worker PC</span>;
  if (r.state === "importing") return <span className="tag amber"><Loader2 size={11} className="spin" />&nbsp;Downloading</span>;
  if (r.state === "recording") return <span className="tag lime"><Radio size={11} />&nbsp;Recording now</span>;
  if (r.state === "processing") return <span className="tag amber">Saving on the worker PC</span>;
  if (r.state === "failed") return <span className="tag" title={r.error ?? ""}>Failed</span>;
  if (!r.preview) return <span className="tag amber">{r.uploading ? "Uploading preview" : "Preparing preview"}</span>;
  return <span className="tag lime">Ready</span>;
}

const requestLabel = (q: RecordingRequest) => q.kind === "moment" ? "Clip " + clock(q.start ?? 0) + "–" + clock(q.end ?? 0) : "Best " + q.count + " moment" + (q.count === 1 ? "" : "s");
const requestState = (q: RecordingRequest) => q.state === "queued" ? "Waiting for the worker PC" : q.state === "working" ? "Making clips" : q.state === "done" ? q.clips + " clip" + (q.clips === 1 ? "" : "s") + " in the library" : "Failed" + (q.error ? ": " + q.error : "");

// Paste a past broadcast or video; the worker PC downloads it as a recording of the chosen streamer (whose look and
// accounts its clips get), optionally clipping its best moments straight away.
function ImportVideo({ streamers, busy, duration, mutate, onImported }: { streamers: StreamerChoice[]; busy: boolean; duration: number; mutate: Mutate; onImported: () => void }) {
  const [url, setUrl] = useState(""), [streamerId, setStreamerId] = useState(""), [count, setCount] = useState(5);
  const link = videoLink(url) as { platform: keyof typeof PLATFORM_NAMES; url: string } | null;
  // A Kick link names its channel: pick that streamer when there is one.
  const guess = link?.platform === "kick" ? streamers.find(s => s.name.toLowerCase() === new URL(link.url).pathname.split("/")[1]) : undefined;
  const chosen = streamerId || guess?.id || streamers[0]?.id || "";
  if (!streamers.length) return <div className="import-video"><small className="muted">Add a streamer first: imported videos are clipped in a streamer's look and posted to their accounts.</small></div>;
  return <form className="import-video" onSubmit={async e => {
    e.preventDefault();
    if (!link || !chosen) return;
    if (await mutate({ action: "importVideo", url: link.url, streamerId: chosen, count })) { setUrl(""); onImported(); }
  }}>
    <label className="field-label" htmlFor="import-url"><Link2 size={13} /> Import a past stream or video</label>
    <input id="import-url" type="url" inputMode="url" placeholder="twitch.tv/videos/…, kick.com/…/videos/… or a YouTube link" value={url} onChange={e => setUrl(e.target.value)} aria-invalid={!!url.trim() && !link} />
    {url.trim() && !link && <small className="engine-error">Use a Twitch or Kick past broadcast link (…/videos/…) or a YouTube video link.</small>}
    <div className="import-video-row">
      <select aria-label="Whose clips" value={chosen} onChange={e => setStreamerId(e.target.value)}>{streamers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
      <select aria-label="Clips to make" value={count} onChange={e => setCount(Number(e.target.value))}>
        <option value={0}>Just import</option>{[3, 5, 8, 10].map(n => <option key={n} value={n}>Best {n} moments</option>)}
      </select>
      <button className="primary" disabled={busy || !link || !chosen}><Download size={15} />Import</button>
    </div>
    <small className="muted">{link ? PLATFORM_NAMES[link.platform] + " video · " : ""}Downloaded on your worker PC, then kept like a recording{count ? "; its " + count + " best moments become " + duration + "s clips" : ""}.</small>
  </form>;
}

export function RecordingsView({ recordings, requests, streamers, storage, busy, workerOnline, duration, mutate, onRefresh, onOpenLibrary }: {
  recordings: Recording[]; requests: RecordingRequest[]; streamers: StreamerChoice[]; storage: boolean; busy: boolean; workerOnline: boolean; duration: number;
  mutate: Mutate; onRefresh: () => void; onOpenLibrary: () => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const open = recordings.find(r => r.id === openId) ?? null;
  // While anything is being imported, recorded, saved or clipped, look again every minute.
  const active = recordings.some(r => r.state === "queued" || r.state === "importing" || r.state === "recording" || r.state === "processing" || (r.state === "ready" && !r.preview)) || requests.some(q => q.state === "queued" || q.state === "working");
  // Only while the tab is in view: a phone or a background tab left open shouldn't keep reading the database.
  useEffect(() => { if (!active) return; const timer = setInterval(() => { if (document.visibilityState === "visible") onRefresh(); }, 60_000); return () => clearInterval(timer); }, [active, onRefresh]);
  const importer = <ImportVideo streamers={streamers} busy={busy} duration={duration} mutate={mutate} onImported={onRefresh} />;
  if (!recordings.length) return <section className="panel"><div className="empty tall"><div className="empty-icon"><Film size={30} /></div><h3>No recordings yet</h3>
    <p>Set a streamer to <strong>Record the whole stream</strong> (or clip live and record) under Channels → Edit. Their next stream is saved on your worker PC, and you can pick clips from it here. Or import a stream that already happened:</p>{importer}</div></section>;
  return <div className="recordings-layout">
    <section className="panel recording-list" aria-label="Recordings">
      <div className="panel-heading"><div><h2>Recordings <span className="count">{recordings.length}</span></h2><p>Whole streams and imported videos kept on your worker PC</p></div></div>
      {importer}
      {recordings.map(r => { const mine = requests.filter(q => q.recording_id === r.id), made = mine.reduce((a, q) => a + q.clips, 0);
        return <button key={r.id} className={"recording-row" + (r.id === open?.id ? " active" : "")} onClick={() => {
          setOpenId(r.id);
          // On a phone the player is below the list: bring it into view.
          if (window.matchMedia("(max-width: 900px)").matches) requestAnimationFrame(() => document.querySelector(".recording-player")?.scrollIntoView({ behavior: "smooth", block: "start" }));
        }}>
          <div className="recording-row-top"><strong>{r.streamer ?? "Removed streamer"}</strong><StateTag r={r} /></div>
          <small>{sourceName(r) ? "Imported from " + sourceName(r) + " " : ""}{when(r.started_at)}{r.duration ? " · " + length(r.duration) : ""}{made ? " · " + made + " clip" + (made === 1 ? "" : "s") + " made" : ""}</small>
          {r.title && <small className="recording-title">{r.title}</small>}
        </button>; })}
      <div className="panel-foot"><span className="small-dot" />Kept until the dates shown, then deleted from the worker PC and here. Change it in Settings.</div>
    </section>
    {open ? <RecordingPlayer key={open.id} r={open} requests={requests.filter(q => q.recording_id === open.id)} storage={storage} busy={busy} workerOnline={workerOnline} duration={duration} mutate={mutate} onOpenLibrary={onOpenLibrary} onDeleted={() => setOpenId(null)} />
      : <section className="panel"><div className="empty tall"><div className="empty-icon"><Scissors size={28} /></div><h3>Choose a recording</h3><p>Watch it, see where chat and the audio got loud, and mark the moments you want as clips.</p></div></section>}
  </div>;
}

// The worker's suggested moments, best first: tick the ones worth posting and only those become clips. A moment
// already asked for shows as such.
function MomentPicks({ moments, recordingId, preview, requests, busy, mutate, onWatch }: {
  moments: Moment[]; recordingId: string; preview: boolean; requests: RecordingRequest[]; busy: boolean; mutate: Mutate; onWatch: (t: number) => void;
}) {
  const [picked, setPicked] = useState<number[]>([]);
  const asked = (m: Moment) => requests.some(q => q.kind === "moment" && q.start === m.start && q.end === m.end && q.state !== "failed");
  const toggle = (s: number) => setPicked(p => p.includes(s) ? p.filter(x => x !== s) : [...p, s]);
  const chosen = moments.filter(m => picked.includes(m.start) && !asked(m));
  return <div className="moment-picks">
    <div className="moment-picks-head"><div><strong>Suggested moments</strong><small>Where the audio, chat{moments.some(m => m.why.some(w => w.endsWith("on screen"))) ? " and the game's own banners" : ""} stood out. Tick the ones to clip.</small></div>
      <button className="primary" disabled={busy || !chosen.length} onClick={async () => { if (await mutate({ action: "makeClips", recordingId, moments: chosen.map(m => ({ start: m.start, end: m.end })) })) setPicked([]); }}><Scissors size={15} />Clip {chosen.length || ""} selected</button></div>
    <div className="moment-grid">{moments.map((m, i) => { const done = asked(m), on = done || picked.includes(m.start);
      return <div key={m.start} className={"moment-card" + (on ? " on" : "")}>
        <label className="moment-thumb">
          {preview ? <video src={"/api/recordings/" + recordingId + "/preview#t=" + (m.start + Math.min(5, (m.end - m.start) / 3))} preload="metadata" muted playsInline tabIndex={-1} /> : <span className="moment-thumb-empty"><Film size={20} /></span>}
          <input type="checkbox" checked={on} disabled={done} onChange={() => toggle(m.start)} aria-label={"Clip the moment at " + clock(m.start)} />
          <span className="moment-rank">#{i + 1}</span>
        </label>
        <div className="moment-info">
          <span className="moment-time">{clock(m.start)}–{clock(m.end)}</span>
          <span className="moment-why">{m.why.map(w => <em key={w} className={w.endsWith("on screen") ? "screen" : undefined}>{w}</em>)}</span>
          <span className="moment-actions"><button type="button" className="text-button" onClick={() => onWatch(m.start)}><Clock3 size={12} />Watch</button>{done && <small className="muted">Asked for</small>}</span>
        </div>
      </div>; })}</div>
  </div>;
}

// Searching what was said: the worker's transcript of the whole recording ([start, end, text] lines), loaded the first
// time someone searches. Each match can be watched, or clipped from a few seconds before it.
type Line = [number, number, string];
function TranscriptSearch({ recordingId, total, duration, busy, mutate, onWatch }: { recordingId: string; total: number; duration: number; busy: boolean; mutate: Mutate; onWatch: (t: number) => void }) {
  const [lines, setLines] = useState<Line[] | null>(null), [query, setQuery] = useState(""), [error, setError] = useState(""), [loading, setLoading] = useState(false);
  const load = () => {
    if (lines || loading) return;
    setLoading(true);
    fetch("/api/recordings/" + recordingId + "/transcript").then(async res => { const json = await res.json().catch(() => null) as { lines?: Line[]; error?: string } | null; if (!res.ok || !json?.lines) throw new Error(json?.error ?? "Couldn't load the transcript."); setLines(json.lines); })
      .catch(e => setError((e as Error).message)).finally(() => setLoading(false));
  };
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  // A line matches when it has every word typed (in any order); results in time order, at most 50.
  const hits = lines && words.length ? lines.filter(l => { const t = l[2].toLowerCase(); return words.every(w => t.includes(w)); }).slice(0, 50) : [];
  const mark = (text: string) => { if (!words.length) return text; const re = new RegExp("(" + words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")", "ig"); return text.split(re).map((part, i) => i % 2 ? <mark key={i}>{part}</mark> : part); };
  const clipAt = async (t: number) => { const start = Math.max(0, Math.round(t) - 5), end = Math.min(total || start + duration, start + duration); if (end - start >= 15) await mutate({ action: "makeClip", recordingId, start, end }); };
  return <div className="transcript-search">
    <label className="search-field"><Search size={15} /><input type="search" placeholder="Search what was said, e.g. raid, giveaway, that's insane" value={query} onFocus={load} onChange={e => { setQuery(e.target.value); load(); }} aria-label="Search what was said in this recording" /></label>
    {loading && <small className="muted"><Loader2 size={12} className="spin" /> Loading the transcript…</small>}
    {error && <div className="error" role="alert">{error}</div>}
    {lines && words.length > 0 && <small className="muted">{hits.length ? hits.length + (hits.length === 50 ? "+" : "") + " place" + (hits.length === 1 ? "" : "s") + " where that was said" : "Not found. The transcript is automatic, so try another spelling or fewer words."}</small>}
    {hits.length > 0 && <div className="transcript-hits">{hits.map(l => <div key={l[0]} className="transcript-hit">
      <span className="moment-time">{clock(l[0])}</span>
      <span className="transcript-text">{mark(l[2])}</span>
      <span className="row-actions"><button type="button" className="text-button" onClick={() => onWatch(Math.max(0, l[0] - 3))}><Clock3 size={12} />Watch</button><button type="button" className="secondary" disabled={busy} title={"A " + duration + "s clip starting 5 seconds before this"} onClick={() => void clipAt(l[0])}><Scissors size={13} />Clip this</button></span>
    </div>)}</div>}
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
    <div className="panel-heading"><div><h2>{r.streamer ?? "Removed streamer"} · {when(r.started_at)}</h2><p>{sourceName(r) ? "Imported from " + sourceName(r) + " · " : ""}{r.title ? r.title + " · " : ""}{total ? length(total) : r.state === "queued" || r.state === "importing" ? "Not downloaded yet" : "Still recording"}{r.size ? " · " + (r.size / 1e9).toFixed(1) + " GB on the worker PC" : ""} · kept until {new Date(r.expires_at).toLocaleDateString()}</p></div>
      {r.state !== "recording" && (confirmDelete
        ? <div className="row-actions"><button className="secondary" onClick={() => setConfirmDelete(false)}>Keep</button><button className="danger" disabled={busy} onClick={async () => { if (await mutate({ action: "deleteRecording", id: r.id })) onDeleted(); }}><Trash2 size={14} />Delete recording</button></div>
        : <button className="icon-button" aria-label="Delete recording" title="Delete recording" onClick={() => setConfirmDelete(true)}><Trash2 size={16} /></button>)}</div>
    <div className="form-body">
      {(r.state === "queued" || r.state === "importing") && <div className="subtle-note">{r.state === "importing" && <Loader2 size={14} className="spin" />} {r.state === "queued" ? "Waiting for your worker PC to start downloading this " + (sourceName(r) ?? "") + " video" + (workerOnline ? " (it checks every minute)." : ". It is offline right now; the download starts when it is back.") : "Your worker PC is downloading this video. A long stream can take a while; then it is saved like a recording and the clips you asked for are made."}{r.source_url && <> <a href={r.source_url} target="_blank" rel="noreferrer">Open the original</a></>}</div>}
      {r.state === "recording" && <div className="subtle-note">This stream is being recorded right now. Once it ends, the worker PC saves it{storage ? " and uploads a small preview here so you can watch it" : ""}.</div>}
      {r.state === "processing" && <div className="subtle-note"><Loader2 size={14} className="spin" /> The worker PC is saving this recording. The heat strip and preview appear in a few minutes.</div>}
      {r.state === "failed" && <div className="error" role="status">This recording failed{r.error ? ": " + r.error : "."}</div>}
      {ready && (r.preview
        ? <video ref={video} className="recording-video" controls playsInline preload="metadata" src={"/api/recordings/" + r.id + "/preview"} onTimeUpdate={e => setAt(e.currentTarget.currentTime)} />
        : <div className="subtle-note">{storage ? (r.uploading ? "The preview is uploading from the worker PC." : "The worker PC is making a small preview to watch here. Meanwhile, pick moments from the heat strip below.") : "Clip storage is off on this site, so there is no preview. Pick moments from the heat strip below."}</div>)}
      {ready && total > 0 && <div>
        <div className="heat recording-heat" ref={strip} onPointerDown={e => seek(timeAt(e.clientX))} title="Click to jump there">
          <div className="heat-bars" aria-hidden>{(signals?.energy ?? []).map((e, i) => { const ch = (signals?.chat[i] ?? 0) / maxChat; return <span key={i} style={{ height: Math.max(4, e * 100) + "%", background: ch > 0.05 ? `color-mix(in srgb, #ff7a59 ${Math.round(ch * 100)}%, #4b5a6b)` : undefined }} />; })}</div>
          {(signals?.moments ?? []).map(m => <i key={m.start} className="heat-moment" style={{ left: pct(m.start), width: pct(m.end - m.start) }} aria-hidden />)}
          {start != null && end != null && <div className="heat-range" style={{ left: pct(start), width: pct(Math.max(1, end - start)) }} />}
          <div className="heat-cursor" style={{ left: pct(at) }} />
        </div>
        <div className="heat-legend"><span><i className="loud" />Loudness</span>{signals?.chat.some(c => c > 0) && <span><i className="chat" />Chat activity</span>}<span className="muted">At {clock(at)} of {clock(total)}</span></div>
      </div>}
      {ready && !!signals?.moments?.length && <MomentPicks moments={signals.moments} recordingId={r.id} preview={r.preview} requests={requests} busy={busy} mutate={mutate} onWatch={seek} />}
      {ready && (r.transcript ? <TranscriptSearch recordingId={r.id} total={total} duration={duration} busy={busy} mutate={mutate} onWatch={seek} /> : <div className="subtle-note"><Search size={14} /> Searching what was said becomes available once the worker PC has transcribed this recording. It does that when it has nothing else to do, so a long stream can take a few hours.</div>)}
      {ready && <div className="moment-picker">
        <div className="moment-fields">
          <label>Start<input data-emoji="off" value={startText} placeholder="0:00" onChange={e => { setStartText(e.target.value); const v = parseClock(e.target.value); setStart(v); }} /></label>
          <button type="button" className="secondary" onClick={() => setFrom(at)}>Start here</button>
          <label>End<input data-emoji="off" value={endText} placeholder={clock(duration)} onChange={e => { setEndText(e.target.value); const v = parseClock(e.target.value); setEnd(v); }} /></label>
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
