import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_SPREAD_DAYS, localClock, planNext, spreadTimes, tiktokBusy } from "../lib/posting-plan.mjs";

test("spreading posts over days: shared out in turn, inside each day's posting hours", () => {
  const at = Date.parse("2026-11-27T19:30:00Z"), evening = [17, 18, 19, 20, 21, 22];
  const times = spreadTimes({ count: 10, days: 5, now: at, hours: evening, timeZone: "Europe/London" });
  assert.equal(times.length, 10);
  assert.ok(times.every((t, i) => i === 0 || t > times[i - 1]), "in order");
  assert.ok(times.every(t => t >= at), "never in the past");
  assert.ok(times.every(t => evening.includes(localClock(t, "Europe/London").hour)), "only in posting hours");
  assert.ok(times.every(t => t % 60_000 === 0), "whole minutes");
  const days = new Set(times.map(t => new Date(t).toISOString().slice(0, 10)));
  assert.equal(days.size, 5, "five days, two a day");
  assert.ok(times.at(-1) < at + 5 * 24 * 3600_000);
  // Uneven: the earlier days take the extra.
  const seven = spreadTimes({ count: 7, days: 3, now: Date.parse("2026-11-28T06:00:00Z"), hours: evening, timeZone: "UTC" });
  const perDay = Object.values(seven.reduce((m, t) => { const d = new Date(t).toISOString().slice(0, 10); m[d] = (m[d] ?? 0) + 1; return m; }, {}));
  assert.deepEqual(perDay, [3, 2, 2]);
  // Late at night, with no posting hours left today, the days start tomorrow.
  const late = spreadTimes({ count: 2, days: 1, now: Date.parse("2026-11-27T23:30:00Z"), hours: [20, 21], timeZone: "UTC" });
  assert.deepEqual(late.map(t => new Date(t).toISOString().slice(0, 13)), ["2026-11-28T20", "2026-11-28T21"]);
  // Any hour allowed: daytime, 9am to 9pm, in the account's time zone.
  assert.ok(spreadTimes({ count: 6, days: 3, now: at, hours: null, timeZone: "Africa/Accra" }).every(t => { const h = localClock(t, "Africa/Accra").hour; return h >= 9 && h < 21; }));
  assert.deepEqual(spreadTimes({ count: 0, days: 3, now: at }), []);
  assert.ok(spreadTimes({ count: 40, days: 999, now: at }).at(-1) < at + (MAX_SPREAD_DAYS + 1) * 24 * 3600_000, "at most 30 days");
});

const now = Date.parse("2026-11-16T12:00:00Z"), h = 3600_000;
const base = { platform: "tiktok", wantsDraft: false, limit: 50, gapMinutes: 0, directToday: 0, draftsToday: 0, lastSentAt: null, oldestSentAt: null, now };

test("TikTok takes 15 a day from apps, drafts included, then waits for the oldest to age out", () => {
  assert.deepEqual(planNext(base), { action: "post" });
  assert.deepEqual(planNext({ ...base, directToday: 14 }), { action: "post" });
  assert.deepEqual(planNext({ ...base, wantsDraft: true, draftsToday: 14 }), { action: "draft" });
  // Once the 15 are used up, a post is held for review; one the owner queued themselves waits for room instead.
  const held = planNext({ ...base, holdWhenFull: true, directToday: 10, draftsToday: 5, oldestSentAt: now - 20 * h });
  assert.equal(held.action, "hold", "drafts count towards the 15");
  assert.match(held.reason, /15 videos a day/);
  assert.equal(planNext({ ...base, holdWhenFull: true, queuedByHand: true, directToday: 15 }).action, "wait");
  const full = planNext({ ...base, directToday: 10, draftsToday: 5, oldestSentAt: now - 20 * h });
  assert.equal(full.action, "wait", "an account set to queue waits");
  assert.equal(full.until, now + 4 * h, "when the oldest is a day old");
  assert.match(full.reason, /15 videos a day.*drafts included/);
});

test("the account's daily limit counts drafts too, and posts are spaced by the gap", () => {
  assert.equal(planNext({ ...base, limit: 10, directToday: 8, draftsToday: 2 }).action, "wait");
  assert.equal(planNext({ ...base, limit: 10, directToday: 8, draftsToday: 1 }).action, "post");
  const gap = planNext({ ...base, gapMinutes: 60, lastSentAt: now - 20 * 60_000 });
  assert.deepEqual([gap.action, gap.until], ["wait", now + 40 * 60_000]);
  assert.equal(planNext({ ...base, gapMinutes: 60, lastSentAt: now - 61 * 60_000 }).action, "post");
});

test("any platform's own daily limit holds posts for review when set to, else they wait", () => {
  const ig = { ...base, platform: "instagram", limit: 20 };
  assert.deepEqual(planNext({ ...ig, holdWhenFull: true, directToday: 20 }), { action: "hold", reason: "daily limit of 20 reached" });
  assert.equal(planNext({ ...ig, holdWhenFull: true, directToday: 19 }).action, "post");
  assert.equal(planNext({ ...ig, holdWhenFull: true, queuedByHand: true, directToday: 20 }).action, "wait");
  assert.equal(planNext({ ...ig, directToday: 20 }).action, "wait");
});

test("other platforms only follow the daily limit and the gap", () => {
  assert.deepEqual(planNext({ ...base, platform: "instagram", directToday: 40 }), { action: "post" });
  assert.equal(planNext({ ...base, platform: "instagram", limit: 40, directToday: 40 }).action, "wait");
});

test("TikTok's 'not now' refusals are recognised", () => {
  assert.equal(tiktokBusy("TikTok: spam_risk_too_many_pending_share"), "drafts");
  assert.equal(tiktokBusy("The user has too many pending shares"), "drafts");
  assert.equal(tiktokBusy("spam_risk_too_many_posts"), "posts");
  assert.equal(tiktokBusy("Video rejected by platform"), null);
});

test("posting hours: windows wrap past midnight and the clock follows the time zone", async () => {
  const { windowHours, localClock, nextOpenAt, hoursLabel } = await import("../lib/posting-plan.mjs");
  assert.deepEqual(windowHours(17, 23), [17, 18, 19, 20, 21, 22]);
  assert.deepEqual(windowHours(22, 2), [22, 23, 0, 1]);
  assert.equal(windowHours(9, 9).length, 24, "same start and end: all day");
  const noonUtc = Date.UTC(2026, 10, 21, 12, 30, 0);
  assert.equal(localClock(noonUtc, "UTC").hour, 12);
  assert.equal(localClock(noonUtc, "America/New_York").hour, 7);
  assert.equal(localClock(noonUtc, "Asia/Kolkata").hour, 18, "half-hour zones too (18:00)");
  assert.equal(localClock(noonUtc, "Not/AZone").hour, 12, "an unknown zone reads as UTC");
  assert.equal(nextOpenAt(noonUtc, [12, 13], "UTC"), null, "inside the window");
  assert.equal(nextOpenAt(noonUtc, [17, 18], "UTC"), Date.UTC(2026, 10, 21, 17, 0, 0));
  assert.equal(nextOpenAt(noonUtc, [9], "UTC"), Date.UTC(2026, 10, 22, 9, 0, 0), "tomorrow morning");
  assert.equal(nextOpenAt(noonUtc, [19], "Asia/Kolkata"), Date.UTC(2026, 10, 21, 13, 30, 0), "19:00 in Kolkata is 13:30 UTC");
  assert.equal(nextOpenAt(noonUtc, [], "UTC"), null);
  assert.equal(hoursLabel([17, 18, 19, 20, 21, 22]), "5pm-11pm");
  assert.equal(hoursLabel([22, 23, 0, 1, 9]), "9am-10am, 10pm-2am");
});

test("bestHours learns from this account's views, and uses evenings until it can", async () => {
  const { bestHours, DEFAULT_BEST_HOURS, MIN_MEASURED } = await import("../lib/posting-plan.mjs");
  const at = h => Date.UTC(2026, 10, 1 + (h % 7), h, 10);
  assert.deepEqual(bestHours([{ at: at(9), views: 100 }], "UTC"), { hours: DEFAULT_BEST_HOURS, learned: false });
  // Morning posts do far better than evening ones.
  const posts = [];
  for (let i = 0; i < MIN_MEASURED; i++) posts.push({ at: at(8 + (i % 3)), views: 5000 }, { at: at(20 + (i % 2)), views: 50 });
  const { hours, learned } = bestHours(posts, "UTC", 3);
  assert.equal(learned, true);
  assert.deepEqual(hours, [8, 9, 10]);
  // The same posts seen from New York (UTC-5) are early-morning posts there.
  assert.deepEqual(bestHours(posts, "America/New_York", 3).hours, [3, 4, 5]);
});

test("spreading evenly spaces the day's posts across the posting hours", async () => {
  const { spreadGap } = await import("../lib/posting-plan.mjs");
  assert.equal(spreadGap([17, 18, 19, 20, 21, 22], 5, 0, true), 72);
  assert.equal(spreadGap(null, 6, 0, true), 240, "all day");
  assert.equal(spreadGap([17, 18], 5, 60, true), 60, "never less than the set gap");
  assert.equal(spreadGap([17, 18], 5, 15, false), 15, "off: the set gap");
});

test("the forecast follows the gap, the posting hours and the daily limit", async () => {
  const { forecast } = await import("../lib/posting-plan.mjs");
  const q = (id, i, extra = {}) => ({ id, createdAt: now - 1000 + i, due: now, ...extra });
  // Noon UTC, hours 17-22, gap 60: the first waits for 5pm, then one an hour.
  const evening = forecast({ platform: "youtube", limit: 5, gapMinutes: 60, hours: [17, 18, 19, 20, 21, 22], timeZone: "UTC", sent: [], queue: [q("a", 0), q("b", 1), q("c", 2)], now });
  assert.deepEqual(["a", "b", "c"].map(id => new Date(evening[id].at).toISOString().slice(11, 16)), ["17:00", "18:00", "19:00"]);
  // Limit 2 with one sent an hour ago: one more now, the next once that one is a day old.
  const full = forecast({ platform: "youtube", limit: 2, gapMinutes: 0, hours: null, sent: [now - h], queue: [q("a", 0), q("b", 1)], now });
  assert.equal(full.a.at, now);
  assert.equal(full.b.at, now - h + 24 * h);
  // Set to hold when full: the second is held for review instead.
  const hold = forecast({ platform: "youtube", limit: 2, gapMinutes: 0, hours: null, holdWhenFull: true, sent: [now - h], queue: [q("a", 0), q("b", 1)], now });
  assert.deepEqual(hold.b, { held: true });
  // Scheduled by hand for 2pm: skips the evening hours and goes then; one minute apart at least.
  const pinned = forecast({ platform: "youtube", limit: 5, gapMinutes: 0, hours: [17], timeZone: "UTC", sent: [], queue: [q("a", 0, { due: now + 2 * h, byHand: true }), q("b", 1, { byHand: true })], now });
  assert.equal(pinned.a.at, now + 2 * h);
  assert.equal(pinned.b.at, now);
  // TikTok: 15 a day whatever the account's own limit.
  const tt = forecast({ platform: "tiktok", limit: 50, gapMinutes: 0, hours: null, sent: Array.from({ length: 15 }, (_, i) => now - 10 * h + i * 60_000), queue: [q("a", 0)], now });
  assert.equal(tt.a.at, now - 10 * h + 24 * h);
});
