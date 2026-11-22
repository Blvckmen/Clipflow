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
