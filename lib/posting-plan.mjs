// Decides what an account does with its next queued post: post it, send it to TikTok drafts, or wait (and until
// when). Pure, so the rules can be tested on their own; the publisher gathers the counts and acts on the answer.
//
// The rules, in order:
//  - The account's own daily limit (or the workspace's) counts everything sent in the last 24 hours, drafts too.
//  - A minimum gap between posts spreads them through the day.
//  - TikTok takes about 15 videos per account per rolling day from apps, and drafts count towards that: a draft
//    is an upload too (seen on a live account: 15 drafts in a day, then the next ones held). Drafts don't add room.
//  - Once a limit is reached (the account's own, or TikTok's 15), an account set to hold (holdWhenFull) holds the post
//    for the owner's review ("hold") rather than letting it wait its turn, unless the owner queued it themselves:
//    then it waits for room like any other.

export const TIKTOK_DAILY = 15;
const DAY = 24 * 3600_000;

/**
 * @param {{ platform: string, wantsDraft: boolean, holdWhenFull?: boolean, queuedByHand?: boolean, limit: number, gapMinutes: number, directToday: number,
 *   draftsToday: number, lastSentAt: number | null, oldestSentAt: number | null, now: number }} s
 * @returns {{ action: "post" | "draft" | "wait" | "hold", until?: number, reason?: string }}
 */
export function planNext(s) {
  const sent = s.directToday + s.draftsToday, hold = !!s.holdWhenFull && !s.queuedByHand;
  if (sent >= s.limit && hold) return { action: "hold", reason: "daily limit of " + s.limit + " reached" };
  if (sent >= s.limit) return { action: "wait", until: s.oldestSentAt === null ? undefined : s.oldestSentAt + DAY, reason: "daily limit of " + s.limit + " reached" };
  if (s.gapMinutes > 0 && s.lastSentAt !== null && s.now - s.lastSentAt < s.gapMinutes * 60_000)
    return { action: "wait", until: s.lastSentAt + s.gapMinutes * 60_000, reason: "spacing posts " + s.gapMinutes + " minutes apart" };
  if (s.platform !== "tiktok") return { action: "post" };
  if (sent >= TIKTOK_DAILY && hold) return { action: "hold", reason: "TikTok's " + TIKTOK_DAILY + " videos a day from apps (drafts included) are used up" };
  if (sent >= TIKTOK_DAILY) return { action: "wait", until: s.oldestSentAt === null ? undefined : s.oldestSentAt + DAY, reason: "TikTok's " + TIKTOK_DAILY + " videos a day from apps (drafts included) are used up" };
  return { action: s.wantsDraft ? "draft" : "post" };
}

// TikTok refusals that mean "not now" rather than "never": the drafts inbox is full, or too many posts today.
// Matched on TikTok's error codes, which Zernio passes through in its messages.
export function tiktokBusy(message) {
  const m = String(message ?? "");
  if (/too_many_pending_share|pending shares?/i.test(m)) return "drafts";
  if (/too_many_posts|spam_risk/i.test(m)) return "posts";
  return null;
}

// ---- Posting hours ----
// An account can post only in some hours of its owner's day: its best hours (learned from its own posts' views) or a
// fixed window. Hours are 0-23 in `timeZone` (an IANA name such as "Africa/Accra"; unknown names fall back to UTC).
export const DEFAULT_BEST_HOURS = [17, 18, 19, 20, 21, 22];  // evenings, until there are enough results
export const MIN_MEASURED = 8;

const zoneOk = timeZone => { try { new Intl.DateTimeFormat("en-GB", { timeZone }); return true; } catch { return false; } };
// The hour, minute and second of `ms` on the clock in `timeZone`.
export function localClock(ms, timeZone = "UTC") {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: zoneOk(timeZone) ? timeZone : "UTC", hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23" }).formatToParts(new Date(ms));
  const get = type => Number(parts.find(p => p.type === type)?.value ?? 0);
  return { hour: get("hour") % 24, minute: get("minute"), second: get("second") };
}

/** The hours of a window from `from` up to (not including) `to`; it may wrap past midnight. from === to: all day. */
export function windowHours(from, to) {
  if (from === to) return Array.from({ length: 24 }, (_, h) => h);
  const out = [];
  for (let h = from; h !== to; h = (h + 1) % 24) out.push(h);
  return out;
}

/**
 * The `count` hours (in `timeZone`) when this account's posts got the most views, smoothed over neighbouring hours
 * so one lucky post doesn't decide. `posts` are { at (ms), views }. Fewer than MIN_MEASURED: DEFAULT_BEST_HOURS.
 * @returns {{ hours: number[], learned: boolean }}
 */
export function bestHours(posts, timeZone = "UTC", count = 6) {
  const measured = (posts ?? []).filter(p => Number.isFinite(p.at) && Number.isFinite(p.views) && p.views >= 0);
  if (measured.length < MIN_MEASURED) return { hours: [...DEFAULT_BEST_HOURS], learned: false };
  const sum = new Array(24).fill(0), n = new Array(24).fill(0);
  for (const p of measured) { const h = localClock(p.at, timeZone).hour; sum[h] += p.views; n[h]++; }
  // Each hour's average views, with half weight from the hours either side (posts reach people for a while).
  const avg = h => n[h] ? sum[h] / n[h] : null;
  // An hour with no posts of its own counts half: its neighbours suggest it, but nothing has been tried there.
  const score = h => { let s = 0, w = 0; for (const [d, k] of [[0, 1], [-1, 0.5], [1, 0.5]]) { const a = avg((h + d + 24) % 24); if (a !== null) { s += a * k; w += k; } } return w ? (s / w) * (n[h] ? 1 : 0.5) : 0; };
  const ranked = Array.from({ length: 24 }, (_, h) => ({ h, s: score(h) })).filter(x => x.s > 0).sort((a, b) => b.s - a.s || a.h - b.h);
  const hours = ranked.slice(0, count).map(x => x.h).sort((a, b) => a - b);
  return hours.length ? { hours, learned: true } : { hours: [...DEFAULT_BEST_HOURS], learned: false };
}

/** null when `now` is inside one of `hours` (in `timeZone`); otherwise when the next of them starts (ms). */
export function nextOpenAt(now, hours, timeZone = "UTC") {
  if (!hours?.length || hours.length >= 24) return null;
  const allowed = new Set(hours), clock = localClock(now, timeZone);
  if (allowed.has(clock.hour)) return null;
  let at = now - (clock.minute * 60 + clock.second) * 1000 - (now % 1000);
  for (let i = 0; i < 26; i++) { at += 3600_000; if (allowed.has(localClock(at + 1000, timeZone).hour)) return at; }
  return null;
}

// ---- Spreading and forecasting ----
// "Spread evenly": the day's posts are spaced across the account's posting hours rather than going out one a minute
// when the hours open. 6 open hours and a limit of 5 leave 72 minutes between posts. Never less than the set gap.
/** @param {number[] | null} hours posting hours (null or 24: all day) */
export function spreadGap(hours, limit, gapMinutes = 0, spread = false) {
  if (!spread || !(limit > 0)) return gapMinutes;
  const open = (hours?.length && hours.length < 24 ? hours.length : 24) * 60;
  return Math.max(gapMinutes, Math.floor(open / limit));
}

/**
 * When each queued post of one account should go out, simulating the publisher's rules: one post a minute at most,
 * the daily limit over a rolling 24 hours (TikTok's 15 too), the gap, and the posting hours (posts queued or
 * scheduled by hand skip the hours). Posts held for review when the account is full come back as "held".
 * An estimate: a clip still rendering or a platform holding a post moves things later.
 * @param {{ platform: string, limit: number, gapMinutes: number, autoGapMinutes?: number, hours: number[] | null, timeZone?: string,
 *   holdWhenFull?: boolean, sent: number[], queue: { id: string, createdAt: number, due: number, byHand?: boolean }[],
 *   now: number, horizonMs?: number }} s
 * @returns {Record<string, { at: number } | { held: true } | { later: true }>}
 */
export function forecast(s) {
  const out = {}, cap = s.platform === "tiktok" ? Math.min(s.limit, TIKTOK_DAILY) : s.limit;
  // Two weeks ahead, or further for a post scheduled by hand beyond that (it still shows at its time).
  const sent = [...s.sent].sort((a, b) => a - b), end = Math.max(s.now + (s.horizonMs ?? 14 * DAY), ...s.queue.filter(q => q.byHand).map(q => q.due + DAY));
  const restricted = s.hours?.length && s.hours.length < 24;
  const pending = s.queue.map(q => ({ ...q, due: Math.max(q.due, s.now) })).sort((a, b) => a.createdAt - b.createdAt);
  let t = s.now;
  for (let guard = 0; pending.length && guard < 5000; guard++) {
    t = Math.max(t, Math.min(...pending.map(p => p.due)));
    if (t > end) break;
    const recent = sent.filter(x => x > t - DAY);
    const due = pending.filter(p => p.due <= t);
    if (recent.length >= cap) {
      // Full: posts the publisher would hold for review are held now; the rest wait for the oldest to age out.
      const held = s.holdWhenFull ? due.filter(p => !p.byHand) : [];
      for (const p of held) { out[p.id] = { held: true }; pending.splice(pending.indexOf(p), 1); }
      if (held.length) continue;
      t = recent[recent.length - cap] + DAY;
      continue;
    }
    const next = due[0], last = sent.at(-1);
    // A post queued by hand keeps only the set gap; the others are spread (autoGapMinutes) when that's on.
    const gap = Math.max(60_000, (next.byHand ? s.gapMinutes : s.autoGapMinutes ?? s.gapMinutes) * 60_000);
    if (last !== undefined && t - last < gap) { t = last + gap; continue; }
    if (!next.byHand && restricted) {
      const opens = nextOpenAt(t, s.hours, s.timeZone);
      // Outside the hours this post waits for them to open (a post queued by hand behind it can still go).
      if (opens !== null) { next.due = opens; continue; }
    }
    out[next.id] = { at: t };
    sent.push(t);
    pending.splice(pending.indexOf(next), 1);
  }
  for (const p of pending) out[p.id] = { later: true };
  return out;
}

// ---- Spreading posts over days (Post… → Spread over N days) ----
// An account that may post at any hour still gets daytime posts: 9am to 9pm.
export const SPREAD_DEFAULT_HOURS = windowHours(9, 21);
export const MAX_SPREAD_DAYS = 30;
const localDay = (ms, timeZone) => new Intl.DateTimeFormat("en-CA", { timeZone: zoneOk(timeZone) ? timeZone : "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
/**
 * When to post `count` clips to one account over `days` days starting now: the clips are shared out across the days
 * (one each in turn, so the earlier days take any extra), and each day's are spaced evenly through that day's posting
 * hours (`hours` in `timeZone`; null or all 24: SPREAD_DEFAULT_HOURS). A day with no posting hours left (today, late
 * in the evening) doesn't count, so there are always `days` days with room. Times are whole minutes, in order.
 * @param {{ count: number, days: number, now: number, hours?: number[] | null, timeZone?: string }} s
 * @returns {number[]} ms timestamps, one per clip
 */
export function spreadTimes({ count, days, now, hours = null, timeZone = "UTC" }) {
  if (!Number.isInteger(count) || count < 1) return [];
  const span = Math.min(MAX_SPREAD_DAYS, Math.max(1, Math.floor(days) || 1));
  const open = new Set(hours?.length && hours.length < 24 ? hours : SPREAD_DEFAULT_HOURS);
  // The open stretches of each day ahead, an hour at a time (the current hour from now on).
  const byDay = new Map(), start = now - (now % 60_000);
  let hourStart = start - (localClock(start, timeZone).minute * 60_000) - (localClock(start, timeZone).second * 1000);
  for (let i = 0; i < (span + 2) * 24 && byDay.size <= span; i++, hourStart += 3600_000) {
    const from = Math.max(hourStart, start), to = hourStart + 3600_000;
    if (to - from < 60_000 || !open.has(localClock(hourStart + 1000, timeZone).hour)) continue;
    const day = localDay(hourStart + 1000, timeZone);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push([from, to]);
  }
  const daysAhead = [...byDay.values()].slice(0, span);
  // Shared out in turn: day 1, day 2, … then round again.
  const perDay = daysAhead.map((_, d) => Math.floor(count / daysAhead.length) + (d < count % daysAhead.length ? 1 : 0));
  const out = [];
  daysAhead.forEach((stretches, d) => {
    const k = perDay[d], total = stretches.reduce((n, [a, b]) => n + b - a, 0);
    for (let i = 0; i < k; i++) {
      // The middle of the i-th of k equal parts of the day's open time.
      let at = total * (i + 0.5) / k;
      for (const [a, b] of stretches) { if (at < b - a) { out.push(Math.round((a + at) / 60_000) * 60_000); break; } at -= b - a; }
    }
  });
  return out.sort((a, b) => a - b);
}

/** "5pm-11pm" style label for a set of hours, joining runs (and runs that wrap past midnight). */
export function hoursLabel(hours) {
  if (!hours?.length) return "";
  if (hours.length >= 24) return "any time";
  const set = new Set(hours), fmt = h => (h % 12 || 12) + (h < 12 ? "am" : "pm");
  const starts = [...set].filter(h => !set.has((h + 23) % 24)).sort((a, b) => a - b);
  return starts.map(s => { let e = s; while (set.has((e + 1) % 24)) e = (e + 1) % 24; return fmt(s) + "-" + fmt((e + 1) % 24); }).join(", ");
}
