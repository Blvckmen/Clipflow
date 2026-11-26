import { test } from "node:test";
import assert from "node:assert/strict";
import { coverageWindow, crowdMoments, enqueueTrigger, MERGE_MS } from "../triggers.mjs";

test("a viewer's live Twitch clip names a merged moment over a chat spike, but not over !clip", () => {
  const q = [];
  enqueueTrigger(q, 0, { atMs: 100_000, reason: "chat" });
  assert.equal(enqueueTrigger(q, 0, { atMs: 105_000, reason: "crowd" }), "merged");
  assert.equal(q[0].reason, "crowd");
  enqueueTrigger(q, 0, { atMs: 108_000, reason: "command" });
  assert.equal(q[0].reason, "command");
  enqueueTrigger(q, 0, { atMs: 110_000, reason: "crowd" });
  assert.equal(q[0].reason, "command", "!clip stays");
});

test("crowdMoments: new viewer clips whose moment is still buffered, timed by the broadcast when known", () => {
  const now = Date.parse("2026-11-26T12:00:00Z"), seen = new Set(["old"]);
  const starts = new Map([["v1", now - 3_600_000]]);
  const list = [
    { id: "old", created_at: new Date(now - 30_000).toISOString(), duration: 30 },
    // Placed in the broadcast: 3600s - 100s in, 30s long, so it ended 70s ago (made later doesn't matter).
    { id: "vod", video_id: "v1", vod_offset: 3500, duration: 30, created_at: new Date(now - 10_000).toISOString() },
    // Not placed yet: its moment ends when it was made.
    { id: "new", video_id: "", vod_offset: null, duration: 25, created_at: new Date(now - 20_000).toISOString() },
    // Ended before the buffer starts.
    { id: "gone", created_at: new Date(now - 300_000).toISOString(), duration: 30 },
    { id: "bad", created_at: "nope" },
  ];
  assert.deepEqual(crowdMoments(list, { seen, starts, earliestMs: now - 200_000, nowMs: now }), [{ atMs: now - 70_000, id: "vod" }, { atMs: now - 20_000, id: "new" }]);
  assert.ok(seen.has("gone") && seen.has("vod"), "remembered, so none comes twice");
  assert.deepEqual(crowdMoments(list, { seen, starts, earliestMs: 0, nowMs: now }), [], "nothing new the second time");
});

test("triggers queue up instead of being dropped; close ones merge and clipped stretches are skipped", () => {
  const q = [];
  assert.equal(enqueueTrigger(q, 0, { atMs: 100_000, reason: "chat" }), "queued");
  assert.equal(enqueueTrigger(q, 0, { atMs: 100_000 + MERGE_MS - 1, reason: "command" }), "merged", "the same moment");
  assert.equal(q[0].reason, "command", "!clip names the merged clip");
  assert.equal(enqueueTrigger(q, 0, { atMs: 160_000, reason: "chat" }), "queued", "a later moment during the cool-down is kept");
  assert.equal(enqueueTrigger(q, 0, { atMs: 130_000, reason: "chat" }), "queued");
  assert.deepEqual(q.map(t => t.atMs), [100_000, 130_000, 160_000], "oldest first");
  assert.equal(enqueueTrigger(q, 200_000, { atMs: 190_000, reason: "chat" }), "covered", "already inside a clip");
});

test("coverageWindow checks back-to-back stretches, never the same footage twice, and waits when the PC is behind", () => {
  const look = 180_000;
  assert.deepEqual(coverageWindow({ coveredUntil: 0, latest: 1_000_000, lookbackMs: look }), { fromMs: 820_000, toMs: 1_000_000 }, "as far back as the buffer");
  assert.deepEqual(coverageWindow({ coveredUntil: 900_000, latest: 1_100_000, lookbackMs: look }), { fromMs: 920_000, toMs: 1_100_000 });
  assert.deepEqual(coverageWindow({ coveredUntil: 970_000, latest: 1_100_000, lookbackMs: look }), null, "only 130s new: wait for 80% (144s) of a window");
  assert.deepEqual(coverageWindow({ coveredUntil: 970_000, latest: 1_100_000, lookbackMs: look, readyShare: 0.5 }), { fromMs: 970_000, toMs: 1_100_000 }, "starts where the last check ended");
  assert.equal(coverageWindow({ coveredUntil: 0, latest: 1_000_000, lookbackMs: look, waiting: 2 }), null, "two checks already waiting");
});

test("coverage checks keep the last 30% of the daily limit for moments people react to", async () => {
  const { coverageRoom } = await import("../triggers.mjs");
  assert.equal(coverageRoom(34, 50), true);
  assert.equal(coverageRoom(35, 50), false, "35 of 50: the rest is for chat spikes, !clip and viewers' clips");
  assert.equal(coverageRoom(0, 1), true, "a limit of 1 still allows one");
  assert.equal(coverageRoom(5, 10, 1), true, "COVERAGE_SHARE=1: the whole limit");
  assert.equal(coverageRoom(7, 10, Number("nonsense")), false, "an unreadable share falls back to 0.7");
});

test("chat spikes, !clip and viewers' clips go before coverage checks, even resumed ones", async () => {
  const { jobRank } = await import("../triggers.mjs");
  const order = [
    { name: "coverage", reason: "audio" }, { name: "resumed coverage", reason: "audio", resumed: true },
    { name: "highlight", kind: "highlight" }, { name: "resumed chat", reason: "chat", resumed: true },
    { name: "chat", reason: "chat" }, { name: "render", kind: "render" }, { name: "viewer", reason: "viewer" },
  ].sort((a, b) => jobRank(a) - jobRank(b)).map(j => j.name);
  assert.deepEqual(order, ["chat", "render", "viewer", "resumed chat", "coverage", "resumed coverage", "highlight"]);
});

test("in a backlog the biggest moments are made first: chosen ones, then the strongest chat spikes", async () => {
  const { pickJob } = await import("../triggers.mjs");
  const job = (id, extra = {}) => ({ id, reason: "chat", ...extra });
  // Arrival order a, b, c: the strongest spike wins, not the oldest.
  assert.equal(pickJob([job("a", { strength: 2.1 }), job("b", { strength: 6.4 }), job("c", { strength: 3 })]).id, "b");
  // Someone typed !clip or a viewer clipped it: ahead of any chat spike.
  assert.equal(pickJob([job("a", { strength: 19 }), job("v", { reason: "viewer" })]).id, "v");
  assert.equal(pickJob([job("a", { strength: 19 }), job("c", { reason: "crowd" })]).id, "c", "a moment viewers clipped live comes before chat spikes");
  assert.equal(pickJob([job("a", { strength: 19 }), job("k", { reason: "command", strength: 1 })]).id, "k");
  // Ties (or no strength measured) keep arrival order.
  assert.equal(pickJob([job("a", { strength: 3 }), job("b", { strength: 3 })]).id, "a");
  assert.equal(pickJob([job("a"), job("b")]).id, "a");
  // The rank still comes first: a strong coverage check waits behind a weak chat spike, a highlight video last.
  assert.equal(pickJob([job("cov", { reason: "audio", strength: 20 }), job("weak", { strength: 1.1 })]).id, "weak");
  assert.equal(pickJob([{ id: "h", kind: "highlight" }, job("x", { reason: "audio" })]).id, "x");
  assert.equal(pickJob([]), null);
});
