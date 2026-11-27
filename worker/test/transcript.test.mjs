import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultEdit, defaultStyle, normalizeEdit, timeline } from "../edit.mjs";
import { countMatches, normalizeSpeakers, replaceWords, rewriteSpan, shiftWords, speakerAt, subtitleFile, subtitleLines, toSrt, toTxt, toVtt } from "../transcript.mjs";

const W = [[10, 10.4, "Hello"], [10.4, 10.8, "chat,"], [10.8, 11.2, "this"], [11.2, 11.6, "is"], [11.6, 12, "Kai"], [12, 12.5, "Cenat!"], [14, 14.4, "What"], [14.4, 14.8, "the"], [14.8, 15.2, "fuck"], [15.2, 15.6, "happened?"]];
const edit = (extra = {}) => ({ ...defaultEdit(defaultStyle({ captions: true }), { trimStart: 10, trimEnd: 30 }), ...extra });

test("find and replace: whole words, phrases, punctuation and timing kept", () => {
  let r = replaceWords(W, "kai cenat", "Kai Cenat");
  assert.equal(r.count, 1);
  assert.deepEqual(r.words[4], [11.6, 12, "Kai"]);
  assert.deepEqual(r.words[5], [12, 12.5, "Cenat!"], "the trailing ! stays, each word keeps its time");
  r = replaceWords(W, "chat", "everyone");
  assert.deepEqual(r.words[1], [10.4, 10.8, "everyone,"], "punctuation around the word stays");
  r = replaceWords(W, "Kai Cenat", "Kai");
  assert.equal(r.words.length, W.length - 1);
  assert.deepEqual(r.words[4], [11.6, 12.5, "Kai!"], "fewer words share the match's time");
  r = replaceWords(W, "this is", "");
  assert.equal(r.words.length, W.length - 2, "an empty replacement removes the words");
  assert.equal(replaceWords(W, "HELLO", "Hi", { matchCase: true }).count, 0);
  assert.equal(replaceWords(W, "hel", "x").count, 0, "whole words only by default");
  r = replaceWords([[0, 1, "eggs"]], "gg", "XX", { wholeWord: false });
  assert.deepEqual(r.words, [[0, 1, "eXXs"]]);
  assert.equal(countMatches(W, "the"), 1);
  assert.equal(countMatches(W, ""), 0);
  // Hidden words between a phrase's words don't stop it matching.
  assert.equal(replaceWords([[0, 1, "Kai"], [1, 1.2, ""], [1.2, 2, "Cenat"]], "kai cenat", "KC").count, 1);
  assert.ok(replaceWords(W, "x", "a".repeat(80)).words.every(w => w[2].length <= 40));
});

test("rewriting a stretch and nudging the timing", () => {
  const r = rewriteSpan(W, 2, 5, "this is Kai Cenat speaking");
  assert.equal(r.length, W.length + 1);
  assert.equal(r[2][0], 10.8);
  assert.equal(r[6][1], 12.5, "the new words fill the old stretch");
  assert.ok(r.slice(2, 7).every((w, i, a) => i === 0 || w[0] >= a[i - 1][1] - 1e-9), "in order");
  assert.equal(rewriteSpan(W, 0, 1, "").length, W.length - 2);
  assert.throws(() => rewriteSpan(W, 3, 1, "x"));
  const s = shiftWords(W, -0.3, { from: 14 });
  assert.deepEqual(s[0], W[0], "before `from`: unchanged");
  assert.deepEqual(s[6], [13.7, 14.1, "What"]);
  assert.deepEqual(shiftWords([[0.1, 0.3, "a"]], -1)[0], [0, 0, "a"], "never below 0");
  assert.throws(() => shiftWords(W, 20));
});

test("speakers: validated, in time order, the last name given for a moment wins", () => {
  const list = normalizeSpeakers([{ at: 14, name: "Chat  guy" }, { at: 10, name: "Kai" }, { at: 14, name: "Duke" }], 40);
  assert.deepEqual(list, [{ at: 10, name: "Kai" }, { at: 14, name: "Duke" }]);
  assert.equal(speakerAt(list, 9), "");
  assert.equal(speakerAt(list, 12), "Kai");
  assert.equal(speakerAt(list, 14.5), "Duke");
  assert.throws(() => normalizeSpeakers("Kai"));
  const saved = normalizeEdit({ ...edit(), speakers: list }, { duration: 40 });
  assert.deepEqual(saved.speakers, list, "an edit keeps its speakers");
  assert.equal(normalizeEdit(edit(), { duration: 40 }).speakers, undefined);
});

test("subtitle files match the burned-in lines", () => {
  const e = edit({ speakers: [{ at: 10, name: "Kai" }, { at: 14, name: "Duke" }] });
  const lines = subtitleLines(e, W);
  assert.ok(lines.length >= 2);
  assert.equal(lines[0].start, 0, "times are in the trimmed clip");
  assert.equal(lines[0].speaker, "Kai");
  assert.equal(lines.at(-1).speaker, "Duke");
  assert.ok(lines.every(l => l.text === l.text.toUpperCase()), "the default look is ALL CAPS, like the video");
  const srt = toSrt(e, W);
  assert.match(srt, /^1\n00:00:00,000 --> 00:00:0\d,\d{3}\n/);
  const vtt = toVtt(e, W);
  assert.ok(vtt.startsWith("WEBVTT\n\n00:00:00.000 --> "));
  assert.ok(vtt.includes("<v Kai>") && vtt.includes("<v Duke>"));
  const masked = toSrt({ ...e, captions: { ...e.captions, mask: true } }, W);
  assert.ok(!/FUCK/.test(masked) && /F\*\*\*/.test(masked), "bleeped like the subtitles");
  const txt = toTxt(e, W, { timestamps: true });
  assert.equal(txt, "[0:00] Kai: Hello chat, this is Kai Cenat!\n\n[0:04] Duke: What the fuck happened?\n");
  // The edit's corrected words come first.
  assert.ok(toTxt({ ...e, words: [[11, 12, "Corrected"]] }, W).includes("Corrected"));
  // After jump cuts, times follow the finished clip.
  const cut = { cuts: [[1, 3]], length: 18, toClip: t => t >= 3 ? t - 2 : t > 1 ? 1 : t, punches: [] };
  assert.equal(subtitleLines(e, W, cut).find(l => l.text.startsWith("WHAT")).start, 2, "4 s into the trim, 2 s cut before it");
  const file = subtitleFile("vtt", e, W, timeline(e, W, null));
  assert.equal(file.ext, "vtt");
  assert.match(file.type, /^text\/vtt/);
  assert.throws(() => subtitleFile("docx", e, W));
  assert.equal(toSrt(edit({ captions: { ...e.captions } }), []), "", "no words, an empty file");
});
