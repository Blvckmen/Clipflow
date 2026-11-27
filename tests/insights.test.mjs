import { test } from "node:test";
import assert from "node:assert/strict";
import { findings, learnedChatWeight, MIN_POSTS, CHAT_WEIGHT } from "../lib/insights.mjs";

const post = (reason, views, duration = 45, hook = true) => ({ reason, views, duration, hook });

test("nothing is concluded from too few measured posts", () => {
  assert.deepEqual(findings([post("chat", 9000), post("audio", 10)]), []);
  assert.equal(learnedChatWeight(Array.from({ length: MIN_POSTS - 1 }, (_, i) => post(i % 2 ? "chat" : "audio", 100))), null);
});

test("a clearly better kind of clip is reported, a small difference isn't", () => {
  const clear = [...Array.from({ length: 6 }, () => post("chat", 4000)), ...Array.from({ length: 6 }, () => post("audio", 500))];
  const f = findings(clear);
  assert.equal(f[0].kind, "reason");
  assert.match(f[0].text, /^Clips from chat spikes get 8x the views of the rest$/);
  const close = [...Array.from({ length: 6 }, () => post("chat", 1100)), ...Array.from({ length: 6 }, () => post("audio", 1000))];
  assert.deepEqual(findings(close).filter(x => x.kind === "reason"), []);
});

test("one viral post doesn't decide (views are compared on a log scale)", () => {
  const rows = [post("audio", 2_000_000), ...Array.from({ length: 5 }, () => post("audio", 100)), ...Array.from({ length: 6 }, () => post("chat", 400))];
  const r = findings(rows).find(x => x.kind === "reason");
  assert.ok(r && r.text.includes("chat spikes"), "typically chat does better, despite the one huge loud-moment post");
});

test("lengths and hooks are compared too", () => {
  const rows = [...Array.from({ length: 6 }, () => post("audio", 3000, 30, true)), ...Array.from({ length: 6 }, () => post("audio", 300, 70, false))];
  const kinds = findings(rows).map(x => x.kind);
  assert.ok(kinds.includes("length") && kinds.includes("hook"));
  assert.match(findings(rows).find(x => x.kind === "length").text, /25-40s/);
});

test("the learned chat weight leans towards whatever did better, within limits", () => {
  const mix = (chatViews, loudViews) => [...Array.from({ length: 6 }, () => post("chat", chatViews)), ...Array.from({ length: 6 }, () => post("audio", loudViews))];
  assert.equal(learnedChatWeight(mix(1000, 1000)), 0.5);
  assert.ok(learnedChatWeight(mix(2000, 1000)) > 0.6 && learnedChatWeight(mix(2000, 1000)) < 0.7);
  assert.equal(learnedChatWeight(mix(100000, 10)), CHAT_WEIGHT.max);
  assert.equal(learnedChatWeight(mix(10, 100000)), CHAT_WEIGHT.min);
  assert.equal(learnedChatWeight([...Array.from({ length: 12 }, () => post("chat", 100))]), null, "no loud-moment clips to compare with");
});
