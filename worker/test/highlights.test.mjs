import { test } from "node:test";
import assert from "node:assert/strict";
import { chatSpike, perSecond, pickWindow, snapToSentences } from "../highlights.mjs";

const T0 = 1_000_000_000_000;
// `rate` messages per second, evenly spread, between two offsets in seconds.
const steady = (fromS, toS, rate) => Array.from({ length: Math.round((toS - fromS) * rate) }, (_, i) => T0 + (fromS + i / rate) * 1000);

test("perSecond buckets millisecond timestamps", () => {
  assert.deepEqual(perSecond([T0, T0 + 999, T0 + 1000, T0 + 2500, T0 - 1, T0 + 5000], T0, 3), [2, 1, 1]);
});

test("chatSpike needs history before anything counts", () => {
  const times = steady(0, 30, 5);
  assert.equal(chatSpike(times, T0 + 30_000, { sinceMs: T0 }).spike, false);
  assert.equal(chatSpike(times, T0 + 30_000, { sinceMs: T0 }).baseline, null);
});

test("chatSpike fires on a burst well above the channel's normal pace", () => {
  // The window is (now-10s, now], so the burst starts just after 290s to land entirely inside it.
  const calm = steady(0, 290, 0.5), burst = steady(290.1, 300, 3);
  const result = chatSpike([...calm, ...burst], T0 + 300_000, { sinceMs: T0 });
  assert.equal(result.spike, true);
  assert.equal(result.recent, 30);
  assert.equal(result.baseline, 5);
});

test("chatSpike ignores a busy chat that is busy all the time", () => {
  assert.equal(chatSpike(steady(0, 300, 3), T0 + 300_000, { sinceMs: T0 }).spike, false);
});

test("chatSpike ignores tiny absolute bursts in near-silent chats", () => {
  assert.equal(chatSpike(steady(295, 300, 0.8), T0 + 300_000, { sinceMs: T0 }).spike, false, "4 messages is below minCount");
});

test("pickWindow follows loudness when there is no chat", () => {
  const energy = Array(60).fill(1); for (let i = 30; i < 40; i++) energy[i] = 10;
  assert.equal(pickWindow({ energy, duration: 10 }), 30);
});

test("pickWindow uses chat shifted back by the reaction lag", () => {
  const energy = Array(60).fill(1), chat = Array(60).fill(0);
  for (let i = 24; i < 34; i++) chat[i] = 20;  // viewers react 4s after a moment at 20..30
  assert.equal(pickWindow({ energy, chat, duration: 10, lag: 4 }), 20);
});

test("pickWindow stays inside the requested range", () => {
  const energy = Array(60).fill(1); energy[2] = 100;
  assert.equal(pickWindow({ energy, duration: 10, from: 20, to: 50 }) >= 20, true);
  assert.equal(pickWindow({ energy: [1, 2, 3], duration: 10 }), 0, "shorter media than the clip starts at 0");
});

test("snapToSentences moves edges to nearby sentence boundaries", () => {
  const segments = [{ start: 8.5, end: 14 }, { start: 14.2, end: 27.6 }, { start: 31, end: 40 }];
  assert.deepEqual(snapToSentences(10, 30, segments), { start: 8.5, end: 27.9 });
});

test("snapToSentences keeps edges when no boundary is close, and respects limits", () => {
  assert.deepEqual(snapToSentences(10, 30, [{ start: 0, end: 50 }]), { start: 10, end: 30 });
  assert.deepEqual(snapToSentences(10, 26, [{ start: 13, end: 27 }], { minLen: 15 }), { start: 10, end: 26 }, "snapping would make it too short");
  assert.deepEqual(snapToSentences(-1, 30, [], { total: 25 }), { start: 0, end: 25 });
});
