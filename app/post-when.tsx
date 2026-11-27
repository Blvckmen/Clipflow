"use client";
// When the Post… dialogs post: as soon as there's room (as before), at a chosen time, or (several clips) spread over a
// number of days through each account's posting hours. The server works out the times (app/api/dashboard postSchedule).
import { CalendarClock } from "lucide-react";

export type PostWhenValue = { mode: "now" } | { mode: "at"; local: string } | { mode: "spread"; days: number };
export type PostSchedule = { at: string } | { days: number };

const pad = (n: number) => String(n).padStart(2, "0");
// A datetime-local value for `ms` in this browser's time zone.
const toLocal = (ms: number) => { const d = new Date(ms); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes()); };
// One hour from now, on the hour: a sensible first pick.
export const nextHour = () => toLocal(Math.ceil((Date.now() + 3600_000) / 3600_000) * 3600_000);

/** The schedule to send, or undefined for "as soon as there's room" (or a time that can't be read). */
export function toSchedule(v: PostWhenValue): PostSchedule | undefined {
  if (v.mode === "at") { const at = new Date(v.local).getTime(); return Number.isFinite(at) ? { at: new Date(at).toISOString() } : undefined; }
  if (v.mode === "spread") return { days: Math.min(30, Math.max(1, Math.round(v.days))) };
  return undefined;
}
// The main button's word: "Post", or "Schedule" when there's a schedule.
export const postVerb = (v: PostWhenValue) => v.mode === "now" ? "Post" : "Schedule";

export function PostWhen({ value, onChange, count = 1 }: { value: PostWhenValue; onChange: (v: PostWhenValue) => void; count?: number }) {
  const per = value.mode === "spread" ? count / value.days : 0;
  return <fieldset className="post-when">
    <legend><CalendarClock size={14} />When</legend>
    <label><input type="radio" name="post-when" checked={value.mode === "now"} onChange={() => onChange({ mode: "now" })} />As soon as there&apos;s room<small>Each account posts in turn, within its daily limit and spacing.</small></label>
    <label><input type="radio" name="post-when" checked={value.mode === "at"} onChange={() => onChange({ mode: "at", local: value.mode === "at" ? value.local : nextHour() })} />At a time
      {value.mode === "at" && <input type="datetime-local" aria-label="Post at" value={value.local} min={toLocal(Date.now())} onChange={e => onChange({ mode: "at", local: e.target.value })} />}
      <small>{count > 1 ? "From then, one after another, within each account's spacing and daily limit." : "It waits until then. The account's spacing and daily limit still apply."}</small></label>
    {count > 1 && <label><input type="radio" name="post-when" checked={value.mode === "spread"} onChange={() => onChange({ mode: "spread", days: value.mode === "spread" ? value.days : Math.min(7, count) })} />Spread over
      {value.mode === "spread" && <span className="post-when-days"><input type="number" min={1} max={30} aria-label="Days" value={value.days} onChange={e => onChange({ mode: "spread", days: Math.min(30, Math.max(1, Number(e.target.value) || 1)) })} /> day{value.days === 1 ? "" : "s"}</span>}
      <small>{value.mode === "spread" ? "About " + (per >= 1 ? Math.round(per * 10) / 10 + " a day" : "one every " + Math.round(1 / per) + " days") + ", spaced through each account's posting hours (9am to 9pm for accounts that post any time)." : "A few a day through each account's posting hours, starting today."}</small></label>}
  </fieldset>;
}
