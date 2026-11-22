import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { autoClipPicks, mergeAiMoments, transcriptWindows } from "../stream-pass.mjs";
import { buildSegmentPrompt, rateSegments } from "../writer.mjs";

const words = n => Array.from({ length: n }, (_, i) => "w" + i).join(" ");

test("transcriptWindows splits the stream into clip-length windows with what was said, skipping near-silent ones", () => {
  const lines = [[5, 20, words(10)], [50, 60, "too few words here"], [95, 120, words(12)]];
  const w = transcriptWindows(lines, { duration: 45, total: 140 });
  assert.deepEqual(w.map(x => [x.start, x.end]), [[0, 45], [90, 135]], "45-90 has only four words");
  assert.match(w[1].text, /^w0 w1/);
  assert.deepEqual(transcriptWindows(lines, { duration: 45, total: 140, skip: 60 }).map(x => x.start), [60], "the opening is skipped; 60-105 holds the 95s line");
});

test("mergeAiMoments adds the AI's titles to moments it agrees with and its own quiet finds", () => {
  const existing = [{ start: 100, end: 145, score: 1, why: ["Loud"] }, { start: 400, end: 445, score: 0.6, why: ["Chat 3× busier"] }];
  const rated = [{ start: 105, end: 150, score: 9, title: "Wins the final round" }, { start: 800, end: 845, score: 9, title: "Tells the car crash story" }, { start: 1000, end: 1045, score: 3, title: "Reads donations" }];
  const m = mergeAiMoments(existing, rated);
  assert.deepEqual(m[0].why, ["AI: Wins the final round", "Loud"], "loud and liked: first, with the AI's reason");
  assert.ok(m.some(x => x.start === 800 && x.why[0] === "AI: Tells the car crash story"), "a quiet story nothing else flagged");
  assert.ok(!m.some(x => x.start === 1000), "low-rated windows aren't added");
  assert.ok(m.find(x => x.start === 800).score > m.find(x => x.start === 400).score, "a 9/10 story outranks a merely busy moment");
  assert.equal(m[0].score, 1);
  assert.deepEqual(mergeAiMoments(existing, []).map(x => x.start), [100, 400], "no ratings: the same list");
});

test("autoClipPicks takes the AI's 8+ moments that weren't clipped yet", () => {
  const rated = [{ start: 0, end: 45, score: 9 }, { start: 45, end: 90, score: 8 }, { start: 90, end: 135, score: 7 }, { start: 135, end: 180, score: 10 }];
  assert.deepEqual(autoClipPicks(rated, [{ start: 140, end: 180 }]).map(x => x.start), [0, 45], "already clipped, and too low, are left");
  assert.deepEqual(autoClipPicks(rated, [], { max: 1 }).map(x => x.start), [135]);
  assert.deepEqual(autoClipPicks(rated, [], { max: 0 }), [], "no room left today");
});

test("rateSegments scores each stretch with a title, or returns null", async () => {
  assert.match(buildSegmentPrompt(["a", "b"], { streamer: "Kai" }), /2 consecutive stretches of a live stream by Kai/);
  let answer = { segments: [{ score: 9, title: "\"Wins the round\"" }, { score: 14, title: "" }] };
  const server = createServer((req, res) => { req.resume(); req.on("end", () => res.end(JSON.stringify({ message: { content: JSON.stringify(answer) } }))); });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  process.env.OLLAMA_URL = "http://127.0.0.1:" + server.address().port;
  try {
    assert.deepEqual(await rateSegments(["a", "b"]), [{ score: 9, title: "Wins the round" }, { score: 10, title: "A moment" }]);
    answer = { segments: [{ score: 5, title: "x" }] };
    assert.equal(await rateSegments(["a", "b"]), null, "one missing");
  } finally { server.close(); delete process.env.OLLAMA_URL; }
});
