import { test } from "node:test";
import assert from "node:assert/strict";
import { planNext, tiktokBusy } from "../lib/posting-plan.mjs";

const now = Date.parse("2026-11-16T12:00:00Z"), h = 3600_000;
const base = { platform: "tiktok", wantsDraft: false, overflow: true, limit: 50, gapMinutes: 0, directToday: 0, draftsToday: 0, lastSentAt: null, oldestDirectAt: null, oldestDraftAt: null, now };

test("TikTok posts directly up to 15, then overflows 5 to drafts, then waits for the oldest to age out", () => {
  assert.deepEqual(planNext(base), { action: "post" });
  assert.deepEqual(planNext({ ...base, directToday: 14 }), { action: "post" });
  assert.deepEqual(planNext({ ...base, directToday: 15 }), { action: "draft" });
  assert.deepEqual(planNext({ ...base, directToday: 15, draftsToday: 4 }), { action: "draft" });
  const full = planNext({ ...base, directToday: 15, draftsToday: 5, oldestDirectAt: now - 20 * h });
  assert.equal(full.action, "wait");
  assert.equal(full.until, now + 4 * h, "when the oldest direct post is a day old");
  assert.match(full.reason, /15 direct posts.*5 drafts/);
});

test("without overflow, the 16th waits; an always-drafts account only has the drafts allowance", () => {
  assert.equal(planNext({ ...base, overflow: false, directToday: 15 }).action, "wait");
  assert.deepEqual(planNext({ ...base, wantsDraft: true }), { action: "draft" });
  const r = planNext({ ...base, wantsDraft: true, draftsToday: 5, oldestDraftAt: now - 23 * h });
  assert.deepEqual([r.action, r.until], ["wait", now + h]);
});

test("the account's daily limit counts drafts too, and posts are spaced by the gap", () => {
  assert.equal(planNext({ ...base, limit: 10, directToday: 8, draftsToday: 2 }).action, "wait");
  assert.equal(planNext({ ...base, limit: 10, directToday: 8, draftsToday: 1 }).action, "post");
  const gap = planNext({ ...base, gapMinutes: 60, lastSentAt: now - 20 * 60_000 });
  assert.deepEqual([gap.action, gap.until], ["wait", now + 40 * 60_000]);
  assert.equal(planNext({ ...base, gapMinutes: 60, lastSentAt: now - 61 * 60_000 }).action, "post");
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
