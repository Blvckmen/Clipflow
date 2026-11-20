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
  assert.deepEqual(layout({ mode: "fit", zoom: 1, x: 0, y: 0 }, 1920, 1080), { w: 720, h: 406, x: 0, y: 437, area: { w: 720, h: 1280, y: 0 }, src: { x: 0, y: 0, w: 1920, h: 1080 } });
  assert.deepEqual(layout({ mode: "crop", zoom: 1, x: 0, y: 0 }, 1920, 1080), { w: 2276, h: 1280, x: -778, y: 0, area: { w: 720, h: 1280, y: 0 }, src: { x: 0, y: 0, w: 1920, h: 1080 } });
  assert.equal(layout({ mode: "crop", zoom: 1, x: 1, y: 0 }, 1920, 1080).x, 0, "sliding the picture fully right shows its left edge");
  assert.equal(layout({ mode: "crop", zoom: 1, x: -1, y: 0 }, 1920, 1080).x, 720 - 2276, "fully left shows its right edge");
  const zoomed = layout({ mode: "blur", zoom: 2, x: 0, y: 0 }, 1920, 1080);
  assert.deepEqual([zoomed.w, zoomed.h], [1440, 810]);
  for (const v of Object.values(layout({ mode: "fit", zoom: 1.37, x: 0.3, y: -0.2 }, 1279, 721)).filter(v => typeof v === "number")) if (typeof v === "number") assert.equal(Number.isInteger(v), true);
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
  assert.deepEqual(top, { w: 1138, h: 640, x: -209, y: 0, area: { w: 720, h: SPLIT_H, y: 0 }, src: { x: 0, y: 0, w: 1920, h: 1080 } }, "16:9 covers 720x640, centred");
  const edit = { ...defaultStyle({ framing: "split" }), trim: { start: 0, end: 10 }, hook: { text: "", seconds: 3, color: "#111111", bg: "#ffffff" } };
  assert.equal(edit.captions.y, 0.5, "captions sit on the seam");
  const graph = filterGraph(edit, { width: 1920, height: 1080 }, null, { background: true });
  assert.match(graph, /\[0:v\]scale=1138:640,crop=720:640:209:0,setsar=1\[st\]/);
  assert.match(graph, /\[1:v\]scale=720:640:force_original_aspect_ratio=increase,crop=720:640,fps=30,setsar=1\[bk\]/);
  assert.match(graph, /\[st\]\[bk\]vstack=inputs=2:shortest=1\[v0\]/);
  assert.doesNotMatch(graph, /drawbox|\[aout\]/, "no divider, no background sound by default");
  assert.match(filterGraph(edit, { width: 1920, height: 1080 }, null), /boxblur/, "no background video: blurred fill instead");
  assert.equal(normalizeStyle({ frame: { mode: "split", background: "0b5A6acf-19ee-570a-9e28-aaf4c6c5765c" } }).frame.background, "0b5a6acf-19ee-570a-9e28-aaf4c6c5765c");
  assert.throws(() => normalizeStyle({ frame: { mode: "split", background: "../etc/passwd" } }), /Background video/);
  assert.equal(normalizeStyle({ frame: { mode: "split", background: "clip:0b5a6acf-19ee-570a-9e28-aaf4c6c5765c" } }).frame.background, "clip:0b5a6acf-19ee-570a-9e28-aaf4c6c5765c", "a gallery clip");
  assert.throws(() => normalizeStyle({ frame: { mode: "split", background: "clip:../x" } }));
  const id = "0b5a6acf-19ee-570a-9e28-aaf4c6c5765c";
  assert.deepEqual(normalizeStyle({ frame: { mode: "split", pool: [id, id.toUpperCase()] } }).frame.pool, [id], "a streamer's background set, without repeats");
  assert.deepEqual(normalizeStyle({ frame: { mode: "fit" } }).frame.pool, [], "older styles: the whole library");
  assert.throws(() => normalizeStyle({ frame: { mode: "split", pool: ["clip:" + id] } }), /Background set/);
  assert.throws(() => normalizeStyle({ frame: { mode: "split", pool: "all" } }), /Background set/);
  assert.equal(normalizeStyle({ frame: { mode: "fit" } }).frame.background, null, "older styles get no background");
});

test("split screen: proportions, order, a divider and the background's sound", async () => {
  const { filterGraph, normalizeStyle, defaultStyle, splitAreas } = await import("../edit.mjs");
  assert.deepEqual(normalizeStyle({ frame: { mode: "split" } }).frame.split, { share: 0.5, top: "stream", divider: null, volume: 0 }, "older styles get the 50/50 split");
  assert.deepEqual(splitAreas({ split: { share: 0.7, top: "stream" } }), { stream: { y: 0, h: 896 }, background: { y: 896, h: 384 }, seam: 896 });
  assert.deepEqual(splitAreas({ split: { share: 0.6, top: "background" } }), { stream: { y: 512, h: 768 }, background: { y: 0, h: 512 }, seam: 512 });
  assert.equal(layout({ mode: "split", zoom: 1, x: 0, y: 0, split: { share: 0.6, top: "background" } }, 1920, 1080).area.y, 512);
  assert.throws(() => normalizeStyle({ frame: { mode: "split", split: { top: "middle" } } }), /Split order/);
  assert.equal(normalizeStyle({ frame: { mode: "split", split: { share: 0.95 } } }).frame.split.share, 0.8, "share kept to 30-80%");
  const style = defaultStyle({ framing: "split" });
  const edit = { ...style, frame: { ...style.frame, split: { share: 0.6, top: "background", divider: "#ffffff", volume: 0.3 } }, trim: { start: 0, end: 10 }, hook: { text: "", seconds: 3, color: "#111111", bg: "#ffffff" } };
  const graph = filterGraph(edit, { width: 1920, height: 1080 }, null, { background: true, audio: { source: true, background: true } });
  assert.match(graph, /crop=720:768:.*\[st\]/);
  assert.match(graph, /crop=720:512,fps=30,setsar=1\[bk\]/);
  assert.match(graph, /\[bk\]\[st\]vstack=inputs=2:shortest=1,drawbox=x=0:y=509:w=720:h=6:color=0xffffff:t=fill\[v0\]/, "background on top, divider on the seam");
  assert.match(graph, /\[1:a\]volume=0\.3,aresample=48000\[ba\];\[sa\]\[ba\]amix=inputs=2:duration=first/);
  assert.match(filterGraph(edit, { width: 1920, height: 1080 }, null, { background: true, audio: { source: false, background: true } }), /\[1:a\]volume=0\.3,aresample=48000,atrim=duration=10/, "background sound alone, cut to the clip");
  assert.doesNotMatch(filterGraph(edit, { width: 1920, height: 1080 }, null, { background: true, audio: { source: true, background: false } }), /\[aout\]/, "a silent background adds nothing");
});

test("facecam layouts: the webcam across the top or in a corner, cut from the same stream", async () => {
  const { filterGraph, normalizeStyle, defaultStyle, facecamPlacement, camAreas } = await import("../edit.mjs");
  assert.deepEqual(normalizeStyle({ frame: { mode: "cam" } }).frame.facecam, { box: null, share: 0.35, corner: "tr", size: 0.36 }, "older styles get the defaults");
  assert.throws(() => normalizeStyle({ frame: { mode: "pip", facecam: { corner: "middle" } } }), /Facecam corner/);
  const box = normalizeStyle({ frame: { mode: "cam", facecam: { box: { x: 0.9, y: 0.2, w: 0.3, h: 0.4 } } } }).frame.facecam.box;
  assert.ok(Math.abs(box.x - 0.7) < 1e-9, "the box is kept inside the stream");
  assert.equal(defaultStyle({ framing: "cam" }).captions.y, 0.35, "captions on the seam");
  const style = defaultStyle({ framing: "cam" }), cam = { ...style.frame, facecam: { ...style.frame.facecam, box: { x: 0, y: 0.33, w: 0.26, h: 0.5 } } };
  assert.deepEqual(camAreas(cam), { cam: { y: 0, h: 448 }, game: { y: 448, h: 832 }, seam: 448 });
  const top = facecamPlacement(cam, 1280, 720);
  assert.deepEqual([top.x, top.y, top.w, top.h], [0, 0, 720, 448]);
  assert.ok(Math.abs(top.sw / top.sh - 720 / 448) < 0.02, "cut to the strip's shape");
  assert.ok(top.sx >= 0 && top.sy >= 0.33 * 720 - 1 && top.sx + top.sw <= 0.26 * 1280 + 2, "from inside the box");
  const edit = { ...style, frame: { ...cam, split: { ...cam.split, divider: "#ffffff" } }, trim: { start: 0, end: 8 }, hook: { text: "", seconds: 3, color: "#111111", bg: "#ffffff" } };
  const g = filterGraph(edit, { width: 1280, height: 720 }, null);
  assert.match(g, /\[0:v\]split\[g\]\[c\]/);
  assert.match(g, /\[g\]scale=\d+:\d+,crop=720:832:/);
  assert.match(g, /\[c\]crop=\d+:\d+:\d+:\d+,scale=720:448,setsar=1\[cam\]/);
  assert.match(g, /\[cam\]\[game\]vstack=inputs=2,drawbox=x=0:y=445/);
  const pip = { ...edit, frame: { ...cam, mode: "pip", facecam: { ...cam.facecam, corner: "bl", size: 0.4 } } };
  const corner = facecamPlacement(pip.frame, 1280, 720);
  assert.deepEqual([corner.x, corner.w], [28, 288]);
  assert.equal(corner.y + corner.h, 1280 - 230, "kept clear of the captions");
  assert.match(filterGraph(pip, { width: 1280, height: 720 }, null), /pad=296:\d+:4:4:color=white\[cam\];\[game\]\[cam\]overlay=24:/);
  assert.match(filterGraph({ ...edit, frame: { ...cam, facecam: { ...cam.facecam, box: null } } }, { width: 1280, height: 720 }, null), /boxblur/, "no webcam box: blurred fill");
});

test("clip shapes: every layout, caption and render follows the chosen aspect", async () => {
  const { filterGraph, normalizeStyle, defaultStyle, canvas, layout, buildAss, ASPECTS } = await import("../edit.mjs");
  assert.deepEqual(Object.keys(ASPECTS), ["9:16", "4:5", "1:1", "16:9"]);
  assert.equal(normalizeStyle({ frame: {} }).frame.aspect, "9:16", "older styles stay portrait");
  assert.throws(() => normalizeStyle({ frame: { aspect: "3:1" } }), /Clip shape/);
  for (const [aspect, [w, h]] of Object.entries(ASPECTS)) {
    assert.deepEqual(canvas({ aspect }), { W: w, H: h });
    assert.ok(Math.abs(w * h - 720 * 1280) / (720 * 1280) < 0.05, aspect + " has about the same number of pixels");
    const style = normalizeStyle({ frame: { aspect, mode: "blur" } });
    const edit = { ...style, trim: { start: 0, end: 8 }, hook: { text: "Hi", seconds: 3, color: "#111111", bg: "#ffffff" } };
    const g = filterGraph(edit, { width: 1920, height: 1080 }, "clip.ass");
    assert.match(g, new RegExp("crop=" + w + ":" + h + ",scale=" + w / 4 + ":" + h / 4 + ",boxblur"), aspect + " blurred fill at its size");
    assert.match(buildAss(edit, []), new RegExp("PlayResX: " + w + "\\nPlayResY: " + h));
    const fit = layout(style.frame, 1920, 1080);
    assert.ok(fit.w <= w && fit.h <= h && (fit.w === w || fit.h === h), aspect + " fits the stream inside");
  }
  // Landscape: nothing to stack, so split screen and facecam-on-top become the blurred fill; the corner box stays.
  assert.equal(normalizeStyle({ frame: { aspect: "16:9", mode: "split" } }).frame.mode, "blur");
  assert.equal(normalizeStyle({ frame: { aspect: "16:9", mode: "cam" } }).frame.mode, "blur");
  assert.equal(normalizeStyle({ frame: { aspect: "16:9", mode: "pip" } }).frame.mode, "pip");
  assert.equal(normalizeStyle({ frame: { aspect: "1:1", mode: "split" } }).frame.mode, "split", "a square still stacks");
  assert.equal(defaultStyle().frame.aspect, "9:16");
});

test("phone mode: the upright phone picture is cut out of the landscape stream and fills the frame", async () => {
  const { filterGraph, normalizeStyle, phoneBox, layout } = await import("../edit.mjs");
  // No picture found: an upright 9:16 picture in the middle of a 1920x1080 stream.
  assert.deepEqual(phoneBox({}, 1920, 1080), { x: 656, y: 0, w: 608, h: 1080 });
  const content = { x: 0.3, y: 0, w: 0.4, h: 1 };
  const frame = normalizeStyle({ frame: { mode: "phone", content } }).frame;
  assert.deepEqual(frame.content, content);
  assert.equal(normalizeStyle({ frame: { mode: "phone", content: { x: 0, y: 0, w: 0, h: 1 } } }).frame.content.w, 0.05, "too thin is widened, not refused");
  assert.throws(() => normalizeStyle({ frame: { mode: "phone", content: { x: "a", y: 0, w: 0.4, h: 1 } } }), /Phone picture left/);
  const box = phoneBox(frame, 1920, 1080);
  assert.deepEqual(box, { x: 576, y: 0, w: 768, h: 1080 });
  const l = layout(frame, 1920, 1080);
  assert.deepEqual(l.src, box);
  assert.ok(l.w >= 720 && l.h >= 1280 && (l.w === 720 || l.h === 1280), "covers the frame");
  const edit = { ...normalizeStyle({ frame: { mode: "phone", content } }), trim: { start: 0, end: 8 }, hook: { text: "", seconds: 3, color: "#111111", bg: "#ffffff" } };
  const g = filterGraph(edit, { width: 1920, height: 1080 }, null);
  assert.match(g, /^color=c=black:s=720x1280:r=30\[bg\];\[0:v\]crop=768:1080:576:0,scale=\d+:\d+\[fg\]/);
  // In a square clip it is cut to fill the square.
  const square = filterGraph({ ...edit, frame: { ...edit.frame, aspect: "1:1" } }, { width: 1920, height: 1080 }, null);
  assert.match(square, /s=960x960/);
});
