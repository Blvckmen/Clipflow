import { test } from "node:test";
import assert from "node:assert/strict";
import { planNext, tiktokBusy } from "../lib/posting-plan.mjs";

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
