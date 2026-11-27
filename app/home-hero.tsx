"use client";
// The top of Home (after the ClipFlow 2.0 Phase 15 design): a welcome with the workspace's numbers, the way to the
// usual next steps, and three clips to pick up (waiting for review first, then the newest). A clip opens in the editor
// when it can be edited, else in the library. Numbers the dashboard doesn't have yet show as "—", never as 0.
import { ArrowRight, Film, Radio, Settings2 } from "lucide-react";
import { ClipThumb } from "./clip-thumb";

type HomeClip = { id: string; streamer: string | null; created_at: string; duration: number; review: string; editable: boolean; edit_rev: number; thumb_rev?: number | null; render_state: string | null };
const ago = (iso: string) => {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  return m < 1 ? "just now" : m < 60 ? m + " min ago" : m < 1440 ? Math.round(m / 60) + " h ago" : Math.round(m / 1440) + " d ago";
};
const plural = (n: number, one: string, many = one + "s") => n + " " + (n === 1 ? one : many);

export function HomeHero({ name, loaded, clips, more, channels, live, onOpen, onView }: {
  name: string | null; loaded: boolean; clips: HomeClip[]; more: boolean; channels: number; live: number;
  onOpen: (clip: HomeClip) => void; onView: (view: string) => void;
}) {
  const pending = clips.filter(c => c.review === "pending"), approved = clips.filter(c => c.review === "approved").length;
  const picks = [...pending, ...clips.filter(c => c.review !== "pending")].slice(0, 3);
  const n = (v: number) => loaded ? String(v) + (more ? "+" : "") : "—";
  const first = name?.trim().split(/\s+/)[0];
  return <section className="home-hero" aria-labelledby="home-title">
    <div className="home-copy">
      <p className="lp-kicker">Your creative space</p>
      <h1 id="home-title">{first ? <>Welcome back, <em>{first}</em>.</> : <>Welcome back.</>}</h1>
      <p className="home-lead">{!loaded ? "Loading your workspace…" : pending.length ? plural(pending.length, "clip") + " waiting for your review." : clips.length ? "You're all caught up." : "Your first clips will land here once a channel goes live."}</p>
      <dl className="home-stats">
        <div><dt>Clips</dt><dd>{n(clips.length)}</dd></div>
        <div><dt>To review</dt><dd>{n(pending.length)}</dd></div>
        <div><dt>Approved</dt><dd>{n(approved)}</dd></div>
        <div><dt>Channels</dt><dd>{loaded ? channels : "—"}{live > 0 && <small className="home-live"><Radio size={11} aria-hidden />{live} live</small>}</dd></div>
      </dl>
      <div className="home-links">
        <button type="button" className="primary" onClick={() => onView("Clip library")}><Film size={16} aria-hidden />{pending.length ? "Review clips" : "Open the library"}</button>
        <button type="button" className="secondary" onClick={() => onView("Recordings")}>Recordings</button>
        <button type="button" className="text-button" onClick={() => onView("Settings")}><Settings2 size={15} aria-hidden />Settings</button>
      </div>
    </div>
    <div className="home-picks" aria-label="Clips to pick up">
      {picks.length ? picks.map(c => <button key={c.id} type="button" className="home-pick" onClick={() => onOpen(c)} title={c.editable ? "Open in the editor" : "Open in the library"}>
        <span className="home-pick-thumb" aria-hidden><ClipThumb clip={c} /></span>
        <span className="home-pick-meta"><strong>{c.streamer ?? "Clip"}</strong><small>{Math.round(c.duration)}s · {ago(c.created_at)}</small></span>
        <span className={"home-pick-tag " + c.review}>{c.review === "pending" ? "To review" : c.review === "approved" ? "Approved" : "Rejected"}</span>
        <ArrowRight size={15} className="home-pick-go" aria-hidden />
      </button>) : <div className="home-empty"><Film size={22} aria-hidden /><p>{loaded ? "No clips yet." : "Loading…"}</p></div>}
    </div>
  </section>;
}
