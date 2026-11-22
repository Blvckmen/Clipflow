import { test } from "node:test";
import assert from "node:assert/strict";
import { coverageWindow, enqueueTrigger, MERGE_MS } from "../triggers.mjs";

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
