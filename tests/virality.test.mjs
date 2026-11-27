import { test } from "node:test";
import assert from "node:assert/strict";
import { viralityScore, viralityLabel } from "../lib/virality.mjs";

test("moments people chose and big chat spikes score above loud moments the worker found", () => {
  const loud = viralityScore({ reason: "audio", rating: 6, loudLift: 1.5 });
  const spike = viralityScore({ reason: "chat", rating: 6, chatLift: 4 });
  const command = viralityScore({ reason: "command", rating: 6, chatLift: 4 });
  assert.ok(loud < spike && spike < command, [loud, spike, command].join(" < "));
  assert.ok(viralityScore({ reason: "chat", chatLift: 6, rating: 10, loudLift: 3 }) >= 90, "everything at once");
  assert.ok(viralityScore({ reason: "audio", rating: 0 }) <= 25, "a moment the AI found dull");
});

test("the score stays within 1-99 and works with only the reason (older clips)", () => {
  assert.equal(viralityScore({ reason: "chat" }), 50);
  assert.equal(viralityScore({}), 40);
  assert.equal(viralityScore({ reason: "command", chatLift: 50, rating: 50, loudLift: 50 }), 99);
  assert.equal(viralityScore({ reason: "audio", rating: -20 }), 19);
  assert.equal(viralityScore({ reason: "audio", rating: Number.NaN, chatLift: null }), 34, "missing values are ignored");
  assert.deepEqual([80, 60, 45, 20].map(viralityLabel), ["Hot", "Promising", "OK", "Weak"]);
});

test("views: a kind of moment that does well for this streamer scores higher, and a posted clip is scored by its views", async () => {
  const { learnedScore } = await import("../lib/virality.mjs");
  const { viewProfile, viewRatio } = await import("../lib/insights.mjs");
  assert.deepEqual(learnedScore(50, {}), { score: 50, why: null }, "nothing learned yet: the score stands");
  const up = learnedScore(50, { reason: "chat", reasonLift: { lift: 2, n: 12 } });
  assert.equal(up.score, 60);
  assert.match(up.why, /chat-spike clips get 2× their usual views/);
  assert.equal(learnedScore(50, { reason: "audio", reasonLift: { lift: 0.5, n: 5 } }).score, 45, "half the views, few posts: half the penalty");
  assert.equal(learnedScore(50, { reasonLift: { lift: 64, n: 50 } }).score, 62, "capped at +12");
  assert.equal(learnedScore(50, { reasonLift: { lift: 3, n: 2 } }).score, 50, "too few posts of that kind to say");
  // Posted: 4x the usual views -> 0.3 * 50 + 0.7 * 86.
  const hit = learnedScore(50, { ratios: [4] });
  assert.equal(hit.score, 75);
  assert.match(hit.why, /Posted: 4× this streamer's usual views/);
  assert.equal(learnedScore(50, { ratios: [1] }).score, 50, "typical views: typical score");
  assert.equal(learnedScore(80, { ratios: [1 / 8] }).score, 25, "a flop pulls a high guess down");
  assert.equal(learnedScore(50, { ratios: [16, 1] }).score, 75, "geometric mean across platforms: sqrt(16 x 1) = 4x");

  // The profile: per-platform medians, and each kind's median ratio against them.
  const posts = [
    ...[100, 120, 80, 110].map(v => ({ platform: "youtube", reason: "audio", views: v })),
    ...[1000, 1200, 900].map(v => ({ platform: "tiktok", reason: "audio", views: v })),
    ...[400, 300, 350].map(v => ({ platform: "youtube", reason: "chat", views: v })),
  ];
  const p = viewProfile(posts);
  assert.equal(p.n, 10);
  assert.equal(p.platforms.tiktok, 1000);
  assert.ok(p.reasons.chat.lift > 2 && p.reasons.audio.lift <= 1, JSON.stringify(p.reasons));
  assert.ok(Math.abs(viewRatio(2000, "tiktok", p) - 2) < 0.02, "against TikTok's own typical");
  assert.equal(viewProfile(posts.slice(0, 4)), null, "too few posts");
});
