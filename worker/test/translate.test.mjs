import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { buildTranslatePrompt, sentencesOf, spreadWords, translateClip } from "../writer.mjs";
import { validateControl } from "../core.mjs";

test("sentencesOf groups words into sentences at punctuation, pauses and every 14 words", () => {
  const w = [[0, 0.3, "no"], [0.3, 0.6, "way."], [0.7, 1, "he"], [1, 1.3, "did"], [3, 3.4, "it"], [3.4, 3.8, "again!"]];
  assert.deepEqual(sentencesOf(w), [{ start: 0, end: 0.6, text: "no way." }, { start: 0.7, end: 1.3, text: "he did" }, { start: 3, end: 3.8, text: "it again!" }]);
  const long = Array.from({ length: 30 }, (_, i) => [i * 0.2, i * 0.2 + 0.2, "w" + i]);
  assert.deepEqual(sentencesOf(long).map(s => s.text.split(" ").length), [14, 14, 2]);
  assert.deepEqual(sentencesOf([[0, 1, ""], [1, 2, "  "]]), []);
});

test("spreadWords times a translated sentence over the original speech, longer words longer", () => {
  const words = spreadWords({ start: 10, end: 12 }, "no {puede} ser");
  assert.deepEqual(words.map(w => w[2]), ["no", "puede", "ser"], "subtitle syntax characters are dropped");
  assert.equal(words[0][0], 10);
  assert.ok(Math.abs(words.at(-1)[1] - 12) < 0.02, "ends with the sentence");
  assert.ok(words[1][1] - words[1][0] > words[0][1] - words[0][0]);
  assert.deepEqual(spreadWords({ start: 0, end: 1 }, "   "), []);
});

test("buildTranslatePrompt asks for one line back per line, keeping names and slang", () => {
  const p = buildTranslatePrompt({ sentences: [{ text: "GG chat" }, { text: "he won" }], hook: "He did NOT see that", caption: "Speed went crazy #clips" }, "pt");
  assert.match(p, /Brazilian Portuguese/);
  assert.match(p, /exactly 2 lines back/);
  assert.match(p, /"sentences":\["GG chat","he won"\]/);
  assert.doesNotMatch(p, /These are names/, "no names line without names");
  assert.match(buildTranslatePrompt({ sentences: [{ text: "x" }], hook: "", caption: "", names: ["Speed"] }, "es"), /never translate them: Speed\./, "a streamer called Speed stays Speed");
});

test("translateClip returns the translation, or null when the answer doesn't fit", async () => {
  let answer = { sentences: ["GG chat", "ganó"], hook: "No lo vio venir", caption: "Speed se volvió loco #clips" };
  const server = createServer((req, res) => { req.resume(); req.on("end", () => res.end(JSON.stringify({ message: { content: JSON.stringify(answer) } }))); });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  process.env.OLLAMA_URL = "http://127.0.0.1:" + server.address().port;
  const input = { sentences: [{ text: "GG chat" }, { text: "he won" }], hook: "He did NOT see that", caption: "x" };
  try {
    assert.deepEqual(await translateClip(input, "es"), answer);
    answer = { ...answer, sentences: ["solo una"] };
    assert.equal(await translateClip(input, "es"), null, "a line missing");
    assert.equal(await translateClip(input, "de"), null, "not a language accounts can pick");
  } finally { server.close(); delete process.env.OLLAMA_URL; }
});

test("validateControl accepts translation requests and refuses malformed ones", () => {
  const base = { control: "running", duration: 45, dailyLimit: 5, captions: true, streamers: [] };
  const t = { id: "11111111-1111-4111-8111-111111111111", lang: "es", rev: 2, edit: { trim: { start: 0, end: 20 } } };
  assert.deepEqual(validateControl({ ...base }).translations, [], "older dashboards send none");
  assert.equal(validateControl({ ...base, translations: [t] }).translations[0].lang, "es");
  assert.throws(() => validateControl({ ...base, translations: [{ ...t, lang: "de" }] }));
  assert.throws(() => validateControl({ ...base, translations: [{ ...t, rev: -1 }] }));
});
