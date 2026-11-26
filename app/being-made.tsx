"use client";
import { AlertTriangle, Check, Clock3, Loader2, Pause } from "lucide-react";

// One clip the worker is making or about to make (worker/core.mjs clipsInProgress, sent with its status report).
export type ClipProgress = { id: string; streamer: string; reason: string | null; stage: "waiting" | "held" | "transcribing" | "choosing" | "rendering" | "uploading" | "failed"; since: string; why?: string };

// The list from the worker's latest report (engine.device.clips); an older worker sends none.
export const clipsOf = (device: unknown): ClipProgress[] => { const list = (device as { clips?: unknown } | null | undefined)?.clips; return Array.isArray(list) ? list as ClipProgress[] : []; };

const STEPS =[["transcribing", "Transcribing"], ["choosing", "Choosing the moment"], ["rendering", "Rendering"], ["uploading", "Uploading"]] as const;
const REASONS: Record<string, string> = { command: "!clip in chat", chat: "Chat spike", crowd: "Viewers clipping", audio: "Loud moment", best: "Best of a recording", manual: "Picked by hand", viewer: "Viewer's Twitch clip" };
const ago = (iso: string, now: number) => { const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000)); return m < 1 ? "just now" : m < 60 ? m + " min" : Math.floor(m / 60) + " h " + (m % 60) + " min"; };

// Clips → Library: what the PC is working on, so a clip that hasn't arrived yet isn't a mystery. Hidden when it's idle.
export function BeingMade({ clips, deviceAt, connected, now, streamerName }: { clips: ClipProgress[]; deviceAt: string | null; connected: boolean; now: number; streamerName: (id: string) => string | null }) {
  if (!clips.length) return null;
  const working = clips.filter(c => c.stage !== "failed").length;
  const stale = !connected || !deviceAt || now - Date.parse(deviceAt) > 15 * 60_000;
  return <section className="panel being-made"><div className="panel-heading"><div><h2>Being made <span className="count">{working}</span></h2><p>{stale ? "Last reported by your PC " + (deviceAt ? ago(deviceAt, now) + " ago" : "a while ago") + "; it may be off or asleep." : "Clips your PC is working on. They appear in the library once uploaded."}</p></div></div>
    <ul className="being-made-list">{clips.map(c => {
      const at = STEPS.findIndex(([s]) => s === c.stage);
      return <li key={c.id + c.stage}>
        <div className="being-made-who"><strong>{streamerName(c.streamer) ?? "Removed channel"}</strong><small>{c.reason ? REASONS[c.reason] ?? c.reason : "Clip"} · {ago(c.since, now)}</small></div>
        {c.stage === "failed" ? <div className="being-made-state bad" title={c.why}><AlertTriangle size={14} />Couldn&apos;t be made{c.why ? ": " + c.why : ""}</div>
          : c.stage === "held" ? <div className="being-made-state"><Pause size={14} />Waiting for Resume</div>
          : c.stage === "waiting" ? <div className="being-made-state"><Clock3 size={14} />In the queue</div>
          : <ol className="stage-track" aria-label={"Stage: " + STEPS[at]?.[1]}>{STEPS.map(([s, label], i) => <li key={s} className={i < at ? "done" : i === at ? "now" : ""}>{i < at ? <Check size={12} /> : i === at ? <Loader2 size={12} className="spin" /> : null}{label}</li>)}</ol>}
      </li>;
    })}</ul></section>;
}
