import { test } from "node:test";
import assert from "node:assert/strict";
import { PRESETS, activeCue, assColor, buildAss, cues, defaultEdit, defaultStyle, filterGraph, layout, maskWord, needsSubtitles, normalizeEdit, normalizeStyle, styleOf } from "../edit.mjs";

const words = [[1, 1.3, "This"], [1.35, 1.6, "is"], [1.65, 2, "insane."], [2.1, 2.4, "What"], [2.45, 2.7, "the"], [2.75, 3, "fuck"], [5, 5.3, "later"]];
const edit = (over = {}) => normalizeEdit({ ...defaultEdit(defaultStyle(), { trimStart: 1, trimEnd: 30 }), ...over }, { duration: 40 });

test("defaultEdit starts from the style and the chosen trim", () => {
  const e = defaultEdit(defaultStyle({ framing: "crop", captions: false }), { trimStart: 6, trimEnd: 51.234 });
  assert.deepEqual(e.trim, { start: 6, end: 51.23 });
  assert.equal(e.frame.mode, "crop");
  assert.equal(e.captions.on, false);
  assert.equal(e.hook.text, "");
});

test("normalizeEdit clamps ranges and rejects bad values with readable messages", () => {
  const e = edit({ frame: { mode: "blur", zoom: 9, x: -4, y: 0 } });
  assert.deepEqual([e.frame.zoom, e.frame.x], [3, -1]);
  assert.throws(() => edit({ trim: { start: 10, end: 12 } }), /at least 5 seconds/);
  assert.throws(() => normalizeEdit({ ...edit(), trim: { start: 0, end: 200 } }, { duration: 300 }), /at most 90 seconds/);
  assert.throws(() => edit({ captions: { ...edit().captions, font: "Papyrus" } }), /Font/);
  assert.throws(() => edit({ captions: { ...edit().captions, color: "red" } }), /colour/);
  assert.throws(() => edit({ frame: { mode: "stretch" } }), /Framing/);
  assert.throws(() => normalizeEdit(null, { duration: 40 }), /Edit is missing/);
});

test("normalizeEdit strips subtitle override syntax from user text", () => {
  const e = edit({ hook: { text: "wait for it {\\b1}\nnow", seconds: 4 }, words: [[1, 2, "hi{\\i1}"]] });
  assert.equal(e.hook.text, "wait for it b1 now");
  assert.deepEqual(e.words, [[1, 2, "hii1"]]);
});

test("normalizeStyle fills parts an older saved style lacks", () => {
  const s = normalizeStyle({ frame: { mode: "fit" } });
  assert.equal(s.frame.mode, "fit");
  assert.equal(s.captions.font, PRESETS.bold.font);
  assert.deepEqual(Object.keys(styleOf(edit())).sort(), ["captions", "frame", "hook", "look", "progress"]);
  assert.equal("text" in styleOf(edit()).hook, false, "hook text belongs to one clip, not the style");
});

test("layout fits, covers, zooms and pans on the 720x1280 frame", () => {
  assert.deepEqual(layout({ mode: "fit", zoom: 1, x: 0, y: 0 }, 1920, 1080), { w: 720, h: 406, x: 0, y: 437, area: { w: 720, h: 1280 } });
  assert.deepEqual(layout({ mode: "crop", zoom: 1, x: 0, y: 0 }, 1920, 1080), { w: 2276, h: 1280, x: -778, y: 0, area: { w: 720, h: 1280 } });
  assert.equal(layout({ mode: "crop", zoom: 1, x: 1, y: 0 }, 1920, 1080).x, 0, "sliding the picture fully right shows its left edge");
  assert.equal(layout({ mode: "crop", zoom: 1, x: -1, y: 0 }, 1920, 1080).x, 720 - 2276, "fully left shows its right edge");
  const zoomed = layout({ mode: "blur", zoom: 2, x: 0, y: 0 }, 1920, 1080);
  assert.deepEqual([zoomed.w, zoomed.h], [1440, 810]);
  for (const v of Object.values(layout({ mode: "fit", zoom: 1.37, x: 0.3, y: -0.2 }, 1279, 721))) if (typeof v === "number") assert.equal(Number.isInteger(v), true);
});

test("cues group words by line length, pauses and sentence ends, relative to the trim", () => {
  const list = cues(words, edit({ captions: { ...edit().captions, words: 3, uppercase: false } }));
  assert.deepEqual(list.map(c => c.words.map(w => w.t).join(" ")), ["This is insane.", "What the fuck", "later"]);
  assert.equal(list[0].start, 0, "the trim starts at 1s");
  assert.ok(list[0].end <= list[1].start, "cues never overlap");
  assert.deepEqual(cues(words, edit({ captions: { ...edit().captions, mask: true } }))[1].words.map(w => w.t), ["WHAT", "THE", "F***"]);
  assert.deepEqual(cues(words, edit({ trim: { start: 2.05, end: 30 } })).map(c => c.words[0].t), ["WHAT", "LATER"], "words before the trim are dropped");
  assert.equal(cues([[1, 2, ""]], edit()).length, 0, "hidden words are skipped");
});

test("activeCue finds the cue and spoken word at a time", () => {
  const list = cues(words, edit());
  assert.deepEqual(activeCue(list, 0.5) && [activeCue(list, 0.5).cue.words[0].t, activeCue(list, 0.5).word], ["THIS", 1]);
  assert.equal(activeCue(list, 3.5), null);
});

test("maskWord keeps the first letter and punctuation", () => {
  assert.equal(maskWord("Fucking!"), "F******!");
  assert.equal(maskWord("hello"), "hello");
});

test("buildAss writes styles and one dialogue per cue, or per word for karaoke and one-word modes", () => {
  assert.equal(assColor("#bcfa76"), "&H0076FABC");
  const plain = buildAss(edit({ captions: { ...edit().captions, animation: "none" } }), words);
  assert.match(plain, /PlayResX: 720\nPlayResY: 1280/);
  assert.match(plain, /Style: Cap,Impact,74,&H00FFFFFF,/);
  assert.equal(plain.match(/^Dialogue: 0,/gm).length, 3);
  const karaoke = buildAss(edit({ captions: { ...edit().captions, animation: "karaoke", highlight: "#ff0000" } }), words);
  assert.equal(karaoke.match(/^Dialogue: 0,/gm).length, 7, "one line per spoken word");
  assert.match(karaoke, /\{\\c&H000000FF\}INSANE\.\{\\c&H00FFFFFF\}/, "the spoken word takes the highlight colour");
  const boxed = buildAss(edit({ captions: { ...PRESETS.boxed, on: true, preset: "boxed", y: 0.5, mask: false } }), words);
  assert.match(boxed, /Style: Cap,Verdana,46,.*,0,0,3,10,0,5,/, "box uses border style 3");
  assert.match(boxed, /\\pos\(360,640\)/);
  const hooked = buildAss(edit({ hook: { text: "He did NOT see that", seconds: 4 }, captions: { ...edit().captions, on: false } }), words);
  assert.equal(hooked.match(/^Dialogue: 0,/gm), null, "captions off");
  assert.match(hooked, /^Dialogue: 1,0:00:00\.00,0:00:04\.00,Hook,.*He did NOT see that$/m);
});

test("needsSubtitles only when there is caption text or a hook", () => {
  assert.equal(needsSubtitles(edit(), words), true);
  assert.equal(needsSubtitles(edit(), []), false);
  assert.equal(needsSubtitles(edit({ captions: { ...edit().captions, on: false } }), words), false);
  assert.equal(needsSubtitles(edit({ hook: { text: "look", seconds: 3 } }), []), true);
});

test("filterGraph frames, adjusts colour, burns subtitles and draws the progress bar", () => {
  const blur = filterGraph(edit(), { width: 1920, height: 1080 }, "clip.ass");
  assert.match(blur, /^\[0:v\]split\[a\]\[b\];\[a\]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,.*boxblur/);
  assert.match(blur, /\[b\]scale=720:406\[fg\];\[bg\]\[fg\]overlay=0:437\[v0\];\[v0\]subtitles=clip\.ass\[v1\];\[v1\]format=yuv420p,setsar=1\[vout\]$/);
  const crop = filterGraph(edit({ frame: { mode: "crop", zoom: 1, x: 0, y: 0 }, look: { brightness: 1.2, contrast: 1.1, saturation: 1 }, progress: { on: true, color: "#ff0000" } }), { width: 1920, height: 1080 }, null);
  assert.match(crop, /^color=c=black:s=720x1280:r=30\[bg\];\[0:v\]lutyuv=y=clip\(16\+\(val-16\)\*1\.2\\,0\\,255\),eq=contrast=1\.1:saturation=1,scale=2276:1280\[fg\]/);
  assert.doesNotMatch(crop, /colorchannelmixer/, "the slow per-pixel mixer is not used");
  assert.match(crop, /color=c=0xff0000:s=720x10:r=30\[bar\];\[v0\]\[bar\]overlay=x='-w\+w\*t\/29':y=main_h-10:eval=frame:shortest=1\[v2\];\[v2\]format=yuv420p/);
  assert.doesNotMatch(crop, /subtitles/);
});

test("split screen: the stream covers the top half and a background video the bottom half", async () => {
  const { filterGraph, SPLIT_H, normalizeStyle, defaultStyle } = await import("../edit.mjs");
  const top = layout({ mode: "split", zoom: 1, x: 0, y: 0 }, 1920, 1080);
  assert.deepEqual(top, { w: 1138, h: 640, x: -209, y: 0, area: { w: 720, h: SPLIT_H } }, "16:9 covers 720x640, centred");
  const edit = { ...defaultStyle({ framing: "split" }), trim: { start: 0, end: 10 }, hook: { text: "", seconds: 3, color: "#111111", bg: "#ffffff" } };
  assert.equal(edit.captions.y, 0.5, "captions sit on the seam");
  const graph = filterGraph(edit, { width: 1920, height: 1080 }, null, { background: true });
  assert.match(graph, /\[0:v\]scale=1138:640,crop=720:640:209:0,setsar=1\[top\]/);
  assert.match(graph, /\[1:v\]scale=720:640:force_original_aspect_ratio=increase,crop=720:640,fps=30,setsar=1\[bot\]/);
  assert.match(graph, /\[top\]\[bot\]vstack=inputs=2:shortest=1\[v0\]/);
  assert.match(filterGraph(edit, { width: 1920, height: 1080 }, null), /boxblur/, "no background video: blurred fill instead");
  assert.equal(normalizeStyle({ frame: { mode: "split", background: "0b5A6acf-19ee-570a-9e28-aaf4c6c5765c" } }).frame.background, "0b5a6acf-19ee-570a-9e28-aaf4c6c5765c");
  assert.throws(() => normalizeStyle({ frame: { mode: "split", background: "../etc/passwd" } }), /Background video/);
  assert.equal(normalizeStyle({ frame: { mode: "fit" } }).frame.background, null, "older styles get no background");
});
