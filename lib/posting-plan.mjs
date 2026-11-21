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

/** "5pm-11pm" style label for a set of hours, joining runs (and runs that wrap past midnight). */
export function hoursLabel(hours) {
  if (!hours?.length) return "";
  if (hours.length >= 24) return "any time";
  const set = new Set(hours), fmt = h => (h % 12 || 12) + (h < 12 ? "am" : "pm");
  const starts = [...set].filter(h => !set.has((h + 23) % 24)).sort((a, b) => a - b);
  return starts.map(s => { let e = s; while (set.has((e + 1) % 24)) e = (e + 1) % 24; return fmt(s) + "-" + fmt((e + 1) % 24); }).join(", ");
}
