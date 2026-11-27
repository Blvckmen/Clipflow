"use client";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { CalendarClock, ChevronLeft, ChevronRight, ExternalLink, Flame, Loader2, RotateCcw, Send, Sparkles, X } from "lucide-react";
import { viralityLabel } from "../lib/virality.mjs";
import { readJson } from "../lib/read-json.mjs";
import type { AccountOptions } from "../lib/account-options";

// Publishing → Calendar: a week of posts per day. What went out, and when everything still queued will go out, as
// forecast by the server with the publisher's own rules (GET /api/calendar). Planned posts can be moved: click one to
// pick a time, post it now or hand it back to automatic; on a computer, drag it to another day (same time of day).
// Each account can be set to auto-schedule: its day's posts spread evenly across its posting hours.
type Kind = "posted" | "planned" | "scheduled" | "posting" | "held" | "later";
type Item = { id: string; clip_id: string; account_id: string; streamer: string | null; score: number | null; duration: number | null; draft: number; kind: Kind; at: string | null; permalink?: string | null; views?: number | null; note?: string | null };
type CalAccount = { id: string; platform: string; username: string; limit: number; gapMinutes: number; spread: boolean; hours: string; hoursLabel: string; timeZone: string; paused: boolean };
type Calendar = { now: string; accounts: CalAccount[]; items: Item[] };
type Mutate = (body: unknown) => Promise<unknown>;

const DAY = 86_400_000;
const kindLabel: Record<Kind, string> = { posted: "Posted", planned: "Planned", scheduled: "Scheduled", posting: "Posting now", held: "Held for review", later: "Later" };
// Monday 00:00 local of the week holding `ms`.
function weekStart(ms: number) { const d = new Date(ms); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); }
const dayKey = (ms: number) => { const d = new Date(ms); return d.getFullYear() + "-" + d.getMonth() + "-" + d.getDate(); };
const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
// A datetime-local value (local time, no zone) and back.
const toLocalInput = (ms: number) => { const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000); return d.toISOString().slice(0, 16); };
const fromLocalInput = (v: string) => new Date(v).getTime();

export function PublishingCalendar({ accounts, brand, platformName, busy, mutate, onDataChanged }: {
  accounts: { id: string; platform: string; username: string; options: AccountOptions }[];
  brand: (name: string) => ReactNode; platformName: (p: string) => string; busy: boolean; mutate: Mutate; onDataChanged?: () => void;
}) {
  const [week, setWeek] = useState(() => weekStart(Date.now()));
  const [cal, setCal] = useState<Calendar | null>(null), [error, setError] = useState(""), [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<string | null>(null), [when, setWhen] = useState(""), [filter, setFilter] = useState("all");
  const [dragging, setDragging] = useState<string | null>(null), [over, setOver] = useState<string | null>(null);
  const [finePointer, setFinePointer] = useState(false);
  useEffect(() => { setFinePointer(matchMedia("(pointer: fine)").matches); }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const end = new Date(week); end.setDate(end.getDate() + 7);
      const r = await fetch("/api/calendar?from=" + new Date(week).toISOString() + "&to=" + end.toISOString());
      const body = await readJson<Calendar & { error?: string }>(r);
      if (!r.ok) throw new Error(body.error);
      setCal(body); setError("");
    } catch (e) { setError(e instanceof Error && e.message ? e.message : "The calendar is unavailable right now."); }
    finally { setLoading(false); }
  }, [week]);
  useEffect(() => { void load(); }, [load]);
  // The forecast moves as posts go out: refresh every minute while the page is open and visible.
  useEffect(() => { const t = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 60_000); return () => clearInterval(t); }, [load]);

  const act = async (body: Record<string, unknown>) => { setOpen(null); const ok = await mutate(body); if (ok) { await load(); onDataChanged?.(); } };
  const schedule = (id: string, at: number | null) => act({ action: "schedulePost", id, at: at === null ? null : new Date(at).toISOString() });
  const autoSchedule = (id: string, on: boolean) => {
    const a = accounts.find(x => x.id === id); if (!a) return;
    // Turning it on also moves an account that posts "any time" to its best hours, which is where spreading pays off.
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    void act({ action: "accountOptions", id, options: on ? { ...a.options, spread: true, hours: a.options.hours === "any" ? "best" : a.options.hours, timeZone: a.options.hours === "any" ? zone : a.options.timeZone } : { ...a.options, spread: false } });
  };

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => { const d = new Date(week); d.setDate(d.getDate() + i); return d.getTime(); }), [week]);
  const byAccount = useMemo(() => new Map((cal?.accounts ?? []).map(a => [a.id, a])), [cal]);
  const shown = (cal?.items ?? []).filter(i => filter === "all" || i.account_id === filter);
  const onDay = useMemo(() => {
    const m = new Map<string, Item[]>();
    for (const i of shown) if (i.at && i.kind !== "held" && i.kind !== "later") { const k = dayKey(Date.parse(i.at)); m.set(k, [...(m.get(k) ?? []), i]); }
    for (const list of m.values()) list.sort((a, b) => Date.parse(a.at!) - Date.parse(b.at!));
    return m;
  }, [shown]);
  const unplaced = shown.filter(i => i.kind === "held" || i.kind === "later");
  const today = dayKey(Date.now()), thisWeek = week === weekStart(Date.now());
  const counts = { posted: shown.filter(i => i.kind === "posted").length, planned: shown.filter(i => (i.kind === "planned" || i.kind === "scheduled" || i.kind === "posting") && i.at && Date.parse(i.at) >= week && Date.parse(i.at) < week + 7 * DAY + 3600_000).length };
  const movable = (i: Item) => i.kind === "planned" || i.kind === "scheduled" || i.kind === "held" || i.kind === "later";
  const label = new Date(week).toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " – " + new Date(days[6]).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

  const drop = (day: number) => {
    const item = cal?.items.find(i => i.id === dragging); setDragging(null); setOver(null);
    if (!item || !movable(item)) return;
    // Same time of day on the new day (or 6pm for one without a time), never in the past.
    const from = item.at ? new Date(item.at) : null, target = new Date(day);
    target.setHours(from ? from.getHours() : 18, from ? from.getMinutes() : 0, 0, 0);
    void schedule(item.id, Math.max(target.getTime(), Date.now()));
  };

  const card = (i: Item) => {
    const a = byAccount.get(i.account_id), isOpen = open === i.id;
    return <li key={i.id} className={"cal-item " + i.kind + (isOpen ? " open" : "") + (dragging === i.id ? " dragging" : "")} draggable={movable(i) && !busy} onDragStart={e => { e.dataTransfer.effectAllowed = "move"; setDragging(i.id); }} onDragEnd={() => { setDragging(null); setOver(null); }}>
      <button className="cal-item-main" onClick={() => { if (!movable(i)) return; setOpen(isOpen ? null : i.id); setWhen(toLocalInput(i.at ? Math.max(Date.parse(i.at), Date.now() + 5 * 60_000) : Date.now() + 3600_000)); }} aria-expanded={movable(i) ? isOpen : undefined} disabled={!movable(i)} title={i.note ?? undefined}>
        <span className="cal-time">{i.at && i.kind !== "held" && i.kind !== "later" ? time(i.at) : kindLabel[i.kind]}</span>
        {a && brand(platformName(a.platform))}
        <span className="cal-what"><strong>{i.streamer ?? "Removed streamer"}</strong><small>{a ? "@" + a.username : "Removed account"}{i.duration ? " · " + Math.round(i.duration) + "s" : ""}{i.draft ? " · draft" : ""}</small></span>
        {i.score != null && <span className={"score-badge " + viralityLabel(i.score).toLowerCase()}><Flame size={10} />{i.score}</span>}
        {i.kind !== "planned" && i.kind !== "held" && i.kind !== "later" && <span className={"cal-kind " + i.kind}>{i.kind === "posted" && i.views != null ? i.views.toLocaleString() + " views" : kindLabel[i.kind]}</span>}
      </button>
      {i.kind === "posted" && i.permalink && <a className="cal-link" href={i.permalink} target="_blank" rel="noreferrer" aria-label="Open the post"><ExternalLink size={12} /></a>}
      {isOpen && <form className="cal-edit" onSubmit={e => { e.preventDefault(); if (when) void schedule(i.id, Math.max(fromLocalInput(when), Date.now())); }}>
        <label>Post at<input type="datetime-local" value={when} min={toLocalInput(Date.now())} onChange={e => setWhen(e.target.value)} required /></label>
        <div className="cal-edit-actions">
          <button className="primary" type="submit" disabled={busy}><CalendarClock size={14} />Schedule</button>
          <button className="secondary" type="button" disabled={busy} onClick={() => void schedule(i.id, Date.now())}><Send size={14} />Post now</button>
          {i.kind === "scheduled" && <button className="secondary" type="button" disabled={busy} onClick={() => void schedule(i.id, null)} title="Let Clipflow pick the time again"><RotateCcw size={14} />Automatic</button>}
          <button className="icon-button" type="button" aria-label="Close" onClick={() => setOpen(null)}><X size={16} /></button>
        </div>
        <small>{i.kind === "held" ? "Scheduling it queues it: it was held because the account had reached its daily limit." : "It waits until then and skips the account's posting hours. The daily limit and spacing still apply."}</small>
      </form>}
    </li>;
  };

  if (!accounts.length) return <section className="panel"><div className="empty tall"><div className="empty-icon"><CalendarClock size={30} /></div><h3>Nothing to plan yet</h3><p>Connect an account under Accounts, and approved clips will appear here at the time they&apos;re due to post.</p></div></section>;

  return <div className="calendar-page">
    <section className="panel cal-accounts">
      <div className="panel-heading"><div><h2>Auto-scheduling</h2><p>Spread each account&apos;s posts evenly through its best hours, instead of posting them as soon as there&apos;s room.</p></div></div>
      <ul>{(cal?.accounts ?? []).map(a => <li key={a.id} className={a.spread ? "on" : ""}>
        {brand(platformName(a.platform))}
        <div><strong>@{a.username}{a.paused && <span className="tag amber">Paused</span>}</strong>
          <small>{a.spread ? "Every " + (a.gapMinutes >= 60 ? Math.round(a.gapMinutes / 6) / 10 + " h" : a.gapMinutes + " min") + " · " : ""}{a.hours === "any" ? "Any time" : (a.hours === "best" ? "Best hours " : "") + a.hoursLabel} · {a.limit} a day</small></div>
        <label className="switch" title={a.spread ? "Turn auto-scheduling off" : "Turn auto-scheduling on"}><input type="checkbox" checked={a.spread} disabled={busy} onChange={e => autoSchedule(a.id, e.target.checked)} /><span aria-hidden /><em>{a.spread ? "Auto" : "Off"}</em></label>
      </li>)}</ul>
    </section>

    <section className="panel cal-panel">
      <div className="cal-toolbar">
        <div className="cal-nav">
          <button className="icon-button" aria-label="Previous week" onClick={() => setWeek(w => weekStart(w - 3 * DAY))}><ChevronLeft size={18} /></button>
          <strong>{label}</strong>
          <button className="icon-button" aria-label="Next week" onClick={() => setWeek(w => weekStart(w + 8 * DAY))}><ChevronRight size={18} /></button>
          {!thisWeek && <button className="text-button" onClick={() => setWeek(weekStart(Date.now()))}>This week</button>}
          {loading && <Loader2 size={15} className="spin muted" />}
        </div>
        <div className="cal-filters">
          <span className="muted">{counts.posted} posted · {counts.planned} planned</span>
          {(cal?.accounts.length ?? 0) > 1 && <select aria-label="Account" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">All accounts</option>{cal!.accounts.map(a => <option key={a.id} value={a.id}>{platformName(a.platform)} @{a.username}</option>)}</select>}
        </div>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="cal-grid">{days.map(d => {
        const k = dayKey(d), list = onDay.get(k) ?? [], past = d + DAY <= Date.now();
        return <div key={k} className={"cal-day" + (k === today ? " today" : "") + (past ? " past" : "") + (over === k ? " drop" : "")}
          onDragOver={e => { if (dragging && !past) { e.preventDefault(); setOver(k); } }} onDragLeave={() => setOver(o => o === k ? null : o)} onDrop={e => { e.preventDefault(); drop(d); }}>
          <div className="cal-day-head"><span>{new Date(d).toLocaleDateString(undefined, { weekday: "short" })}</span><b>{new Date(d).getDate()}</b>{list.length > 0 && <small>{list.length}</small>}</div>
          {list.length ? <ul>{list.map(card)}</ul> : <p className="cal-none">{past ? "—" : "Nothing planned"}</p>}
        </div>;
      })}</div>
      <p className="cal-hint muted"><Sparkles size={13} />Planned times are an estimate from each account&apos;s limit, spacing and hours; they move if a clip is still rendering or a platform holds a post.{finePointer ? " Drag a post to another day to move it." : " Tap a post to move it."}</p>
    </section>

    {unplaced.length > 0 && <section className="panel">
      <div className="panel-heading"><div><h2>Not on the calendar</h2><p>Held because an account was full, or due more than two weeks out. Pick a time for any of them.</p></div><span className="tag">{unplaced.length}</span></div>
      <ul className="cal-unplaced">{unplaced.map(card)}</ul>
    </section>}
  </div>;
}
