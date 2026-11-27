"use client";
// Viewers' Twitch clips (lib/viewer-clips.mjs): the workspace settings, a streamer's own, and the list of clips the
// worker found while set to "ask me first", to make into clips or dismiss.
import { useState } from "react";
import { Check, ExternalLink, Eye, Loader2, Users, X } from "lucide-react";

export type ViewerClipsWs = { perDay: number; maxHours: number; ask: boolean };
export type ViewerClipsOwn = { on?: boolean; minViews?: number; perDay?: number; maxHours?: number; ask?: boolean };
export type Candidate = { clip_id: string; streamer_id: string; title: string; views: number; duration: number; creator: string | null; thumbnail: string | null; clip_created_at: string; moment_at: string | null; state: "waiting" | "wanted" | "failed"; error: string | null; updated_at: string };

const VIEWS = [3, 10, 50, 200, 1000, 5000, 20000];
const PER_DAY = [1, 2, 3, 5, 10, 20];
const HOURS: [number, string][] = [[3, "3 hours"], [6, "6 hours"], [12, "12 hours"], [24, "day"], [48, "2 days"], [72, "3 days"]];
const hoursLabel = (h: number) => HOURS.find(([n]) => n === h)?.[1] ?? h + " hours";

// Settings → the workspace's viewers' clips: the fewest views (0 is off), and with it on, the daily cap, how fresh the
// moments must be, and whether to ask first.
export function ViewerClipsSettings({ importClips, value, onChange }: { importClips: number; value: ViewerClipsWs; onChange: (importClips: number, value: ViewerClipsWs) => void }) {
  const on = importClips > 0, set = (patch: Partial<ViewerClipsWs>) => onChange(importClips, { ...value, ...patch });
  return <fieldset className="viewer-clip-settings"><legend>Viewers&apos; Twitch clips</legend>
    <label>Import<select value={importClips} onChange={e => onChange(Number(e.target.value), value)}>
      <option value={0}>Don&apos;t import</option>
      {[...new Set([...VIEWS, ...(on && !VIEWS.includes(importClips) ? [importClips] : [])])].sort((a, b) => a - b).map(n => <option key={n} value={n}>Clips with {n.toLocaleString()}+ views</option>)}
    </select><small>Clips viewers made on your running Twitch streamers&apos; channels, checked every 30 minutes and made in the streamer&apos;s look. Each streamer can have its own setting (edit the streamer). Needs a Twitch app on the worker PC: see the worker README.</small></label>
    {on && <div className="viewer-clip-grid">
      <label>Most a day<select value={value.perDay} onChange={e => set({ perDay: Number(e.target.value) })}>{PER_DAY.map(n => <option key={n} value={n}>{n} per streamer</option>)}</select>
        <small>Apart from the daily clip limit.</small></label>
      <label>Only moments from the last<select value={value.maxHours} onChange={e => set({ maxHours: Number(e.target.value) })}>{HOURS.map(([n, l]) => <option key={n} value={n}>{l}</option>)}</select>
        <small>When it happened on stream, not when it was clipped.</small></label>
    </div>}
    {on && <label className="check-row"><input type="checkbox" checked={value.ask} onChange={e => set({ ask: e.target.checked })} /><span>Ask me first<small>The clips found are listed under Clips → Library for you to pick; only the ones you pick are made.</small></span></label>}
  </fieldset>;
}

// A streamer's own viewers' clips choices, each "workspace" or its own value. Twitch streamers only.
type Pick = "workspace" | "on" | "off";
export function StreamerViewerClips({ value, onChange, ws }: { value: ViewerClipsOwn; onChange: (v: ViewerClipsOwn) => void; ws: { importClips: number } & ViewerClipsWs }) {
  const mode: Pick = value.on === undefined ? "workspace" : value.on ? "on" : "off";
  const on = mode === "on" || (mode === "workspace" && ws.importClips > 0);
  const set = (k: keyof ViewerClipsOwn, v: number | boolean | undefined) => { const next = { ...value }; if (v === undefined) delete next[k]; else (next as Record<string, unknown>)[k] = v; onChange(next); };
  const num = (k: "minViews" | "perDay" | "maxHours", raw: string) => set(k, raw === "" ? undefined : Number(raw));
  const minViews = value.minViews ?? (ws.importClips > 0 ? ws.importClips : 10);
  return <fieldset className="viewer-clip-settings"><legend>Viewers&apos; Twitch clips</legend>
    <label>Import<select value={mode} onChange={e => set("on", e.target.value === "workspace" ? undefined : e.target.value === "on")}>
      <option value="workspace">Workspace setting ({ws.importClips > 0 ? "on, " + ws.importClips.toLocaleString() + "+ views" : "off"})</option><option value="on">On for this streamer</option><option value="off">Off for this streamer</option>
    </select></label>
    {on && <div className="viewer-clip-grid">
      <label>Fewest views<input inputMode="numeric" data-emoji="off" value={value.minViews ?? ""} placeholder={String(minViews)} onChange={e => { const n = Number(e.target.value); num("minViews", e.target.value.trim() && Number.isInteger(n) && n >= 1 && n <= 100000 ? String(n) : ""); }} />
        <small>{value.minViews ? "Its own." : mode === "on" && !(ws.importClips > 0) ? "10 unless you set one." : "The workspace's."} A big channel needs more.</small></label>
      <label>Most a day<select value={value.perDay ?? ""} onChange={e => num("perDay", e.target.value)}><option value="">Workspace ({ws.perDay})</option>{PER_DAY.map(n => <option key={n} value={n}>{n}</option>)}</select></label>
      <label>Only moments from the last<select value={value.maxHours ?? ""} onChange={e => num("maxHours", e.target.value)}><option value="">Workspace ({hoursLabel(ws.maxHours)})</option>{HOURS.map(([n, l]) => <option key={n} value={n}>{l}</option>)}</select></label>
      <label>Ask me first<select value={value.ask === undefined ? "" : value.ask ? "yes" : "no"} onChange={e => set("ask", e.target.value === "" ? undefined : e.target.value === "yes")}><option value="">Workspace ({ws.ask ? "yes" : "no"})</option><option value="yes">Yes: list them for me to pick</option><option value="no">No: make them straight away</option></select></label>
    </div>}
  </fieldset>;
}

const ago = (iso: string | null) => {
  const t = iso ? Date.parse(iso) : NaN; if (!Number.isFinite(t)) return "";
  const m = Math.max(0, Math.round((Date.now() - t) / 60_000));
  return m < 60 ? m + " min ago" : m < 48 * 60 ? Math.round(m / 60) + " h ago" : Math.round(m / 1440) + " days ago";
};
const length = (s: number) => Math.round(s) + "s";

// The clips found while "ask me first" is on: tick some, make them or dismiss them.
export function ViewerClipsPanel({ candidates, streamers, busy, mutate }: { candidates: Candidate[]; streamers: { id: string; name: string }[]; busy: boolean; mutate: (body: unknown) => Promise<unknown> }) {
  const [picked, setPicked] = useState<string[]>([]);
  if (!candidates.length) return null;
  const name = (id: string) => streamers.find(s => s.id === id)?.name ?? "Removed streamer";
  const open = candidates.filter(c => c.state !== "wanted"), ticked = picked.filter(id => open.some(c => c.clip_id === id));
  const act = async (op: "make" | "dismiss", ids: string[]) => { if (ids.length && await mutate({ action: "viewerClips", op, ids })) setPicked(p => p.filter(id => !ids.includes(id))); };
  return <section className="panel viewer-clips-panel">
    <div className="panel-heading"><div><h2>Viewers&apos; clips to pick</h2><p>{open.length ? "Found on Twitch while “Ask me first” is on. Pick the ones to make into clips." : "Being made by your worker PC."}</p></div>
      {open.length > 0 && <div className="row-actions">
        <button className="secondary" disabled={busy} onClick={() => setPicked(ticked.length === open.length ? [] : open.map(c => c.clip_id))}>{ticked.length === open.length ? "Untick all" : "Tick all"}</button>
        <button className="secondary" disabled={busy || !ticked.length} onClick={() => void act("dismiss", ticked)}><X size={14} />Dismiss{ticked.length ? " " + ticked.length : ""}</button>
        <button className="primary" disabled={busy || !ticked.length} onClick={() => void act("make", ticked)}><Check size={14} />Make {ticked.length || ""} clip{ticked.length === 1 ? "" : "s"}</button>
      </div>}
    </div>
    <div className="viewer-clips">{candidates.map(c => {
      const on = ticked.includes(c.clip_id), making = c.state === "wanted";
      return <article key={c.clip_id} className={"viewer-clip" + (on ? " picked" : "") + (making ? " making" : "")}>
        <label className="viewer-clip-pick">
          <input type="checkbox" disabled={making} checked={on} onChange={e => setPicked(p => e.target.checked ? [...p, c.clip_id] : p.filter(x => x !== c.clip_id))} aria-label={"Pick " + c.title} />
          <span className="viewer-clip-thumb">{c.thumbnail ? <img src={c.thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" /> : null}<span className="viewer-clip-length">{length(c.duration)}</span></span>
        </label>
        <div className="viewer-clip-body">
          <strong title={c.title}>{c.title}</strong>
          <small className="muted">{name(c.streamer_id)} · <Eye size={12} /> {c.views.toLocaleString()} · {ago(c.moment_at ?? c.clip_created_at)}{c.creator ? <> · <Users size={12} /> {c.creator}</> : null}</small>
          {c.state === "failed" && <small className="error-text">{c.error ?? "Couldn't be made."} Pick it again to retry.</small>}
          <div className="viewer-clip-actions">
            {making ? <span className="tag amber"><Loader2 size={12} className="spin" />Being made</span> : <>
              <button className="text-button" disabled={busy} onClick={() => void act("make", [c.clip_id])}><Check size={13} />Make clip</button>
              <button className="text-button" disabled={busy} onClick={() => void act("dismiss", [c.clip_id])}><X size={13} />Dismiss</button></>}
            <a className="text-button" href={"https://clips.twitch.tv/" + encodeURIComponent(c.clip_id)} target="_blank" rel="noreferrer noopener"><ExternalLink size={13} />Watch</a>
          </div>
        </div>
      </article>;
    })}</div>
  </section>;
}
