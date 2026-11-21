import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { candidateWindows, chooseMoment, pickWindow } from "../highlights.mjs";
import { buildRatePrompt, rateMoments } from "../writer.mjs";

test("candidateWindows lists distinct spots, the best loudness-and-chat one first", () => {
  const energy = Array.from({ length: 120 }, (_, i) => (i >= 20 && i < 30 ? 10 : i >= 80 && i < 90 ? 6 : 1));
  const c = candidateWindows({ energy, duration: 20, count: 3 });
  assert.equal(c[0].start, pickWindow({ energy, duration: 20 }), "the first is pickWindow's choice");
  assert.equal(c[0].score, 1);
  assert.ok(c.every((x, i) => c.every((y, j) => i === j || Math.abs(x.start - y.start) >= 10)), "spread apart");
  assert.ok(c.some(x => x.start >= 70 && x.start <= 80), "the second loud part is a candidate");
  assert.deepEqual(candidateWindows({ energy: [1, 1, 1], duration: 20 }).map(x => x.start), [0], "a window shorter than a clip gives one");
});

test("chooseMoment weighs the rating of what was said against loudness and chat", () => {
  const cands = [{ start: 10, end: 40, score: 1 }, { start: 60, end: 90, score: 0.8 }, { start: 100, end: 130, score: 0.5 }];
  assert.equal(chooseMoment(cands, null).start, 10, "no ratings: the loudest");
  assert.equal(chooseMoment(cands, [2, 9, 5]).start, 60, "a much better-rated moment wins");
  assert.equal(chooseMoment(cands, [6, 7, 5]).start, 10, "a slightly better rating doesn't beat a much louder moment");
  assert.equal(chooseMoment(cands, [1, 2]).start, 10, "ratings that don't line up are ignored");
  assert.equal(chooseMoment([], [1]), null);
});

test("buildRatePrompt numbers the moments and includes context", () => {
  const p = buildRatePrompt(["first {bit}", "second"], { streamer: "Kai", title: "Elden Ring", chat: ["LUL (x4)"] });
  assert.match(p, /2 candidate moments.*by Kai/);
  assert.match(p, /Moment 1[^\n]*\n+first bit/);
  assert.match(p, /Moment 2/);
  assert.match(p, /LUL \(x4\)/);
});

test("rateMoments asks Ollama once and returns one score per moment, or null", async () => {
  let asked = 0, answer = { scores: [3, 11, 7] };
  const server = createServer((req, res) => { asked++; req.resume(); req.on("end", () => res.end(JSON.stringify({ message: { content: JSON.stringify(answer) } }))); });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  process.env.OLLAMA_URL = "http://127.0.0.1:" + server.address().port;
  try {
    assert.deepEqual(await rateMoments(["a", "b", "c"]), [3, 10, 7], "clamped to 0..10");
    assert.equal(asked, 1);
    answer = { scores: [1, 2] };
    assert.equal(await rateMoments(["a", "b", "c"]), null, "wrong count");
    assert.equal(await rateMoments(["only one"]), null, "nothing to choose between");
    process.env.AI_PICKER = "off";
    assert.equal(await rateMoments(["a", "b"]), null);
  } finally { delete process.env.AI_PICKER; server.close(); }
  process.env.OLLAMA_URL = "http://127.0.0.1:9";
  assert.equal(await rateMoments(["a", "b"]), null, "Ollama not running");
  delete process.env.OLLAMA_URL;
});

test("chatWeight shifts the pick between the loudest and the chattiest moment", async () => {
  const { validateControl } = await import("../core.mjs");
  // Loud at 10-20s, chat at 70-80s (chat counts 4s after a moment, like real chat).
  const energy = Array.from({ length: 100 }, (_, i) => (i >= 10 && i < 20 ? 10 : 1)), chat = Array.from({ length: 100 }, (_, i) => (i >= 74 && i < 84 ? 10 : 0));
  assert.ok(pickWindow({ energy, chat, duration: 10, chatWeight: 0.2 }) < 30, "leaning on loudness");
  assert.ok(pickWindow({ energy, chat, duration: 10, chatWeight: 0.8 }) > 60, "leaning on chat");
  assert.equal(candidateWindows({ energy, chat, duration: 10, chatWeight: 0.8 })[0].start, pickWindow({ energy, chat, duration: 10, chatWeight: 0.8 }));
  const base = { control: "running", duration: 45, dailyLimit: 5, captions: true };
  const s = { id: "11111111-1111-4111-8111-111111111111", url: "https://twitch.tv/alpha", status: "armed" };
  assert.equal(validateControl({ ...base, streamers: [{ ...s, chatWeight: 0.7 }] }).streamers[0].chatWeight, 0.7);
  assert.throws(() => validateControl({ ...base, streamers: [{ ...s, chatWeight: 2 }] }));
});
