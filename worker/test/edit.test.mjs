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
  assert.equal(e.hook.text, "wait for it b1\nnow", "line breaks in a hook are kept");
  assert.deepEqual(e.words, [[1, 2, "hii1"]]);
});

test("normalizeStyle fills parts an older saved style lacks", () => {
  const s = normalizeStyle({ frame: { mode: "fit" } });
  assert.equal(s.frame.mode, "fit");
  assert.equal(s.captions.font, PRESETS.bold.font);
  assert.deepEqual(Object.keys(styleOf(edit())).sort(), ["audio", "captions", "chat", "frame", "hook", "look", "pace", "progress"]);
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
  const karaoke = buildAss(edit({ captions: { ...edit().captions, animation: "karaoke", highlight: "#ff0000", keywords: false } }), words);
  assert.equal(karaoke.match(/^Dialogue: 0,/gm).length, 7, "one line per spoken word");
  assert.match(karaoke, /\{\\c&H000000FF\}INSANE\.\{\\c&H00FFFFFF\}/, "the spoken word takes the highlight colour");
  // Keywords on: "insane" stands out in the keyword colour and bigger, and in the highlight colour while it's spoken.
  const keyed = buildAss(edit({ captions: { ...edit().captions, animation: "karaoke", highlight: "#ff0000", keywords: true, keywordColor: "#00ff00" } }), words);
  assert.match(keyed, /\{\\c&H0000FF00\\fscx115\\fscy115\}INSANE\.\{\\c&H00FFFFFF\\fscx100\\fscy100\}/);
  assert.match(keyed, /\{\\c&H000000FF\\fscx115\\fscy115\}INSANE\./);
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
  assert.deepEqual(normalizeStyle({ frame: { mode: "cam" } }).frame.facecam, { box: null, share: 0.35, corner: "tr", size: 0.36, place: "top", shape: "box" }, "older styles get the defaults");
  assert.throws(() => normalizeStyle({ frame: { mode: "cam", facecam: { place: "middle" } } }), /Facecam place/);
  assert.throws(() => normalizeStyle({ frame: { mode: "pip", facecam: { shape: "star" } } }), /Facecam shape/);
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

test("templates: bottom split and circle facecam", async () => {
  const { filterGraph, defaultStyle, facecamPlacement, camAreas, templateOf, TEMPLATE_IDS } = await import("../edit.mjs");
  assert.deepEqual(TEMPLATE_IDS, ["cam", "camBottom", "blur", "pip", "circle", "crop", "fit", "split", "phone", "duo", "duoStack", "squad", "gameUi", "gameUiCam"]);
  const bottom = defaultStyle({ framing: "camBottom" });
  assert.deepEqual([bottom.frame.mode, bottom.frame.facecam.place, bottom.captions.y], ["cam", "bottom", 0.65]);
  assert.equal(templateOf(bottom.frame), "camBottom");
  assert.equal(templateOf(defaultStyle({ framing: "cam" }).frame), "cam");
  assert.equal(defaultStyle({ framing: "nope" }).frame.mode, "blur", "an unknown template is the blurred fill");
  const box = { x: 0, y: 0.33, w: 0.26, h: 0.5 }, hook = { text: "", seconds: 3, color: "#111111", bg: "#ffffff" };
  const frame = { ...bottom.frame, facecam: { ...bottom.frame.facecam, box } };
  assert.deepEqual(camAreas(frame), { cam: { y: 832, h: 448 }, game: { y: 0, h: 832 }, seam: 832 });
  assert.equal(facecamPlacement(frame, 1280, 720).y, 832);
  assert.match(filterGraph({ ...bottom, frame, trim: { start: 0, end: 8 }, hook }, { width: 1280, height: 720 }, null), /\[game\]\[cam\]vstack=inputs=2/);
  const circle = defaultStyle({ framing: "circle" });
  assert.equal(templateOf(circle.frame), "circle");
  const cf = { ...circle.frame, facecam: { ...circle.frame.facecam, box } }, fp = facecamPlacement(cf, 1280, 720);
  assert.equal(fp.w, fp.h, "a circle is square");
  assert.ok(Math.abs(fp.sw - fp.sh) <= 2, "cut square from the box");
  const g = filterGraph({ ...circle, frame: cf, trim: { start: 0, end: 8 }, hook }, { width: 1280, height: 720 }, null);
  assert.match(g, /\[cc\]\[mask\]alphamerge\[cam\]/);
  assert.match(g, /\[gr\]\[cam\]overlay=\d+:\d+\[v0\]/);
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

test("a hook keeps its line breaks (up to 3 lines) and renders them as new lines", () => {
  const edit = normalizeEdit({ ...defaultEdit(defaultStyle(), { trimStart: 0, trimEnd: 20 }), hook: { text: "He did NOT\r\n\n  see   that\ncoming\nat all\nreally", seconds: 4, color: "#111111", bg: "#ffffff" } }, { duration: 60 });
  assert.equal(edit.hook.text, "He did NOT\nsee that\ncoming", "empty lines dropped, spaces tidied, 3 lines at most");
  assert.match(buildAss(edit, []), /He did NOT\\Nsee that\\Ncoming/);
  assert.equal(normalizeEdit({ ...edit, hook: { ...edit.hook, text: "one line {\\b1}" } }, { duration: 60 }).hook.text, "one line b1", "override codes are stripped");
});

test("keywordScore and keywordsOf pick the word that matters in a caption line", async () => {
  const { keywordScore, keywordsOf } = await import("../edit.mjs");
  assert.equal(keywordScore("the"), 0);
  assert.equal(keywordScore("um"), 0);
  assert.ok(keywordScore("insane!") >= 5, "emphatic, with an exclamation");
  assert.equal(keywordScore("$500"), 5);
  assert.equal(keywordScore("10k"), 5);
  assert.equal(keywordScore("WHAT"), 0, "a shouted stop word still isn't a keyword");
  assert.ok(keywordScore("NOOO") >= 3, "shouting counts");
  assert.equal(keywordScore("Speed", true), 1, "a capital at the start of a line means nothing");
  assert.equal(keywordScore("Speed", false), 2, "mid-line it's probably a name");
  assert.deepEqual([...keywordsOf(["that", "was", "actually", "insane"])], [3]);
  assert.deepEqual([...keywordsOf(["i", "think", "so"])], [], "nothing important");
  assert.deepEqual([...keywordsOf(["he", "got", "$500", "in", "one", "insane", "round"])].sort(), [2, 5], "two on a long line");
});

test("cues mark keywords only when captions.keywords is on, judged before ALL CAPS", async () => {
  const { cues, normalizeStyle, defaultStyle } = await import("../edit.mjs");
  const ws = [[0, 0.3, "that"], [0.3, 0.6, "was"], [0.6, 1, "insane"]];
  const style = defaultStyle();
  const on = cues(ws, { ...style, trim: { start: 0, end: 5 }, captions: { ...style.captions, words: 4 } });
  assert.deepEqual(on[0].words.map(w => w.k), [false, false, true]);
  assert.equal(on[0].words[2].t, "INSANE", "the bold preset is ALL CAPS");
  const off = cues(ws, { ...style, trim: { start: 0, end: 5 }, captions: { ...style.captions, words: 4, keywords: false } });
  assert.ok(off[0].words.every(w => !w.k));
  // Looks saved before keywords existed get them, in their preset's colour.
  const old = { ...style, captions: { ...style.captions } }; delete old.captions.keywords; delete old.captions.keywordColor;
  assert.equal(normalizeStyle(old).captions.keywords, true);
  assert.equal(normalizeStyle({ ...old, captions: { ...old.captions, preset: "boxed" } }).captions.keywordColor, "#1d4ed8");
});

test("opening title on/off keeps its text, and a look copies without the clip's own text", async () => {
  const { showsHook, withTextStyle } = await import("../edit.mjs");
  const base = defaultEdit(defaultStyle({ captions: true }), { trimStart: 0, trimEnd: 30 });
  const titled = normalizeEdit({ ...base, hook: { ...base.hook, text: "He did NOT see that" } }, { duration: 40 });
  assert.equal(titled.hook.on, true, "older edits show their title");
  assert.ok(showsHook(titled));
  const hidden = normalizeEdit({ ...titled, hook: { ...titled.hook, on: false } }, { duration: 40 });
  assert.equal(hidden.hook.text, "He did NOT see that", "hiding keeps the text");
  assert.ok(!showsHook(hidden));
  assert.ok(!buildAss(hidden, [], 1080, 1920).includes("He did NOT"), "a hidden title isn't drawn");
  assert.ok(buildAss(titled, [], 1080, 1920).includes("He did NOT"));
  assert.ok(!needsSubtitles(hidden, []), "nothing to burn in");
  assert.equal(styleOf(hidden).hook.on, false);
  // Copying a look: colours and sizes come over; the text and both switches stay the clip's own.
  const look = { ...styleOf(titled), captions: { ...titled.captions, on: false, color: "#00ff00", size: 90 }, hook: { ...titled.hook, on: true, color: "#ff0000", size: 80 } };
  const copied = withTextStyle(hidden, look);
  assert.equal(copied.captions.color, "#00ff00");
  assert.equal(copied.captions.size, 90);
  assert.equal(copied.captions.on, true, "subtitles stay on");
  assert.equal(copied.hook.color, "#ff0000");
  assert.equal(copied.hook.on, false, "the title stays hidden");
  assert.equal(copied.hook.text, "He did NOT see that");
  assert.doesNotThrow(() => normalizeEdit(copied, { duration: 40 }));
});

test("text style: bold, italic, shadow and alignment, the title following the subtitles unless it has its own", async () => {
  const { hookLook, alignedX } = await import("../edit.mjs");
  const base = normalizeEdit({ ...defaultEdit(defaultStyle({ captions: true }), { trimStart: 0, trimEnd: 30 }), hook: { text: "Watch this" } }, { duration: 40 });
  assert.equal(base.captions.bold, true, "older looks stay bold");
  assert.equal(base.captions.italic, false);
  assert.equal(base.captions.shadow, 0);
  assert.equal(base.captions.align, "center");
  assert.equal(base.hook.own, false);
  const styleLine = (ass, name) => ass.split("\n").find(l => l.startsWith("Style: " + name + ",")).split(",");
  // Format: Name, Fontname, Fontsize, Primary, Secondary, Outline, Back, Bold, Italic, ..., Shadow at index 17.
  let ass = buildAss(base, [], undefined);
  assert.equal(styleLine(ass, "Cap")[7], "-1");
  assert.equal(styleLine(ass, "Hook")[1], base.captions.font, "the title uses the subtitle font");
  const styled = normalizeEdit({ ...base, captions: { ...base.captions, bold: false, italic: true, shadow: 3, align: "left" } }, { duration: 40 });
  ass = buildAss(styled, [[1, 1.5, "hello"]], undefined);
  assert.deepEqual(styleLine(ass, "Cap").slice(7, 9), ["0", "-1"]);
  assert.equal(styleLine(ass, "Cap")[17], "3");
  assert.deepEqual(styleLine(ass, "Hook").slice(7, 9), ["0", "-1"], "the title follows bold and italic");
  assert.equal(styleLine(ass, "Hook")[17], "3", "and the shadow");
  const own = normalizeEdit({ ...styled, hook: { ...styled.hook, own: true, font: "Arial", bold: true, italic: false, shadow: 0, uppercase: true, align: "right" } }, { duration: 40 });
  assert.deepEqual(hookLook(own), { font: "Arial", bold: true, italic: false, shadow: 0, uppercase: true, align: "right" });
  ass = buildAss(own, [], undefined);
  assert.equal(styleLine(ass, "Hook")[1], "Arial");
  assert.deepEqual(styleLine(ass, "Hook").slice(7, 9), ["-1", "0"]);
  assert.ok(ass.includes("WATCH THIS"), "capitals");
  assert.ok(ass.includes("{\\an9\\pos("), "right aligned title");
  assert.equal(normalizeEdit(styled, { duration: 40 }).captions.align, "left");
  assert.ok(buildAss(styled, [[0.5, 1, "hello"]], undefined).includes("{\\an4\\pos(40,"), "left aligned subtitles");
  assert.equal(alignedX("left", 540, 1000, 300), 40);
  assert.equal(alignedX("right", 540, 1000, 300), 740);
  assert.equal(alignedX("center", 540, 1000, 300), 390);
  assert.throws(() => normalizeEdit({ ...base, captions: { ...base.captions, align: "justify" } }, { duration: 40 }));
  assert.equal(styleOf(own).hook.text, undefined, "a look has no title text");
  assert.equal(styleOf(own).hook.font, "Arial");
});

test("opening title: fade or no animation, and lines in their own colour and size", async () => {
  const { hookLines, HOOK_FADE_MS } = await import("../edit.mjs");
  const base = normalizeEdit({ ...defaultEdit(defaultStyle({ captions: true }), { trimStart: 0, trimEnd: 30 }), hook: { text: "He did NOT\nsee that coming" } }, { duration: 40 });
  const hookLine = e => buildAss(e, []).split("\n").find(l => l.startsWith("Dialogue: 1,"));
  assert.equal(base.hook.anim, "pop", "older titles pop in");
  const B = String.fromCharCode(92); // a backslash, as in ASS override tags
  assert.ok(hookLine(base).includes(B + "fscx82"), "pop");
  assert.ok(hookLine(base).endsWith("He did NOT" + B + "Nsee that coming"), "no per-line tags when no line has its own look");
  const fade = normalizeEdit({ ...base, hook: { ...base.hook, anim: "fade" } }, { duration: 40 });
  assert.ok(hookLine(fade).includes(B + "fad(" + HOOK_FADE_MS + "," + HOOK_FADE_MS + ")") && !hookLine(fade).includes(B + "fscx82"));
  const still = normalizeEdit({ ...base, hook: { ...base.hook, anim: "none" } }, { duration: 40 });
  assert.ok(!hookLine(still).includes(B + "fad") && !hookLine(still).includes(B + "fscx82"));
  assert.throws(() => normalizeEdit({ ...base, hook: { ...base.hook, anim: "spin" } }, { duration: 40 }));
  const lined = normalizeEdit({ ...base, hook: { ...base.hook, lines: [null, { color: "#FF0000", size: 80 }] } }, { duration: 40 });
  assert.deepEqual(lined.hook.lines, [null, { color: "#ff0000", size: 80 }]);
  assert.deepEqual(hookLines(lined).map(l => [l.color, l.size]), [[base.hook.color, base.hook.size], ["#ff0000", 80]]);
  const ass = hookLine(lined);
  assert.ok(ass.includes("{" + B + "c&H000000FF" + B + "fs80}see") && ass.includes(B + "fs80}see that coming"), "the second line red and bigger");
  assert.ok(ass.includes(B + "fs" + base.hook.size + "}He did NOT"), "the first line in the title's own size");
  assert.throws(() => normalizeEdit({ ...base, hook: { ...base.hook, lines: [{ size: 500 }, null, null, null] } }, { duration: 40 }));
  // A look carries the animation but not one clip's line formatting.
  assert.equal(styleOf(lined).hook.lines, undefined);
  assert.equal(styleOf(fade).hook.anim, "fade");
  assert.equal(hookLines({ ...lined, hook: { ...lined.hook, uppercase: true } })[1].text, "SEE THAT COMING");
});

test("multi-webcam templates: duo, duo stack and squad lay each person out from the same stream", async () => {
  const { defaultStyle, multiAreas, multiPlacements, filterGraph, normalizeStyle, templateOf, captionSeat } = await import("../edit.mjs");
  const hook = { text: "", seconds: 3, color: "#111111", bg: "#ffffff" };
  const p1 = { x: 0.02, y: 0.05, w: 0.26, h: 0.4 }, p2 = { x: 0.72, y: 0.05, w: 0.26, h: 0.4 }, p3 = { x: 0.02, y: 0.55, w: 0.26, h: 0.4 }, p4 = { x: 0.72, y: 0.55, w: 0.26, h: 0.4 };
  const duo = defaultStyle({ framing: "duo" });
  assert.equal(templateOf(duo.frame), "duo");
  assert.deepEqual(multiAreas(duo.frame), { game: { x: 0, y: 384, w: 720, h: 512 }, cams: [{ x: 0, y: 0, w: 720, h: 384 }, { x: 0, y: 896, w: 720, h: 384 }] });
  assert.equal(duo.captions.y, captionSeat(duo.frame));
  assert.ok(duo.captions.y > 384 / 1280 && duo.captions.y < 896 / 1280, "subtitles in the game, off the faces");
  assert.equal(multiPlacements(duo.frame, 1280, 720), null, "no boxes yet");
  const withBoxes = f => ({ ...f, facecam: { ...f.facecam, box: p1 }, cams: [p2, p3, p4] });
  const placed = multiPlacements(withBoxes(duo.frame), 1280, 720);
  assert.equal(placed.length, 2);
  assert.ok(Math.abs(placed[0].sw / placed[0].sh - 720 / 384) < 0.02, "cut to the strip's shape");
  assert.ok(placed[1].sx >= 0.72 * 1280 - 1, "person 2 from their own box");
  const g = filterGraph({ ...duo, frame: withBoxes(duo.frame), trim: { start: 0, end: 8 }, hook }, { width: 1280, height: 720 }, null);
  assert.match(g, /split=3\[g\]\[c0\]\[c1\]/);
  assert.match(g, /\[base\]\[game\]overlay=0:384:shortest=1\[m0\]/);
  assert.match(g, /\[m1\]\[k1\]overlay=0:896\[v0\]/);
  assert.match(filterGraph({ ...duo, frame: { ...duo.frame, facecam: { ...duo.frame.facecam, box: p1 } }, trim: { start: 0, end: 8 }, hook }, { width: 1280, height: 720 }, null), /boxblur/, "one box for two people: blurred fill");
  const stack = defaultStyle({ framing: "duoStack" });
  assert.deepEqual(multiAreas(stack.frame).cams.map(c => [c.x, c.w]), [[0, 360], [360, 360]]);
  assert.ok(stack.captions.y <= (1280 - 360) / 1280 + 0.001, "kept above the app's text");
  const squad = defaultStyle({ framing: "squad" });
  assert.equal(multiAreas(squad.frame).cams.length, 4);
  assert.match(filterGraph({ ...squad, frame: withBoxes(squad.frame), trim: { start: 0, end: 8 }, hook }, { width: 1280, height: 720 }, null), /split=5.*\[m3\]\[k3\]overlay=360:960\[v0\]/);
  assert.equal(normalizeStyle({ frame: { mode: "duo", aspect: "16:9" } }).frame.mode, "blur", "landscape can't stack");
  assert.throws(() => normalizeStyle({ frame: { mode: "squad", cams: [p2, p3, p4, p1] } }), /Webcams/);
  assert.throws(() => normalizeStyle({ frame: { mode: "duo", cams: [{ x: 0, y: 0, w: 0 }] } }), /Webcam 2/);
  assert.deepEqual(normalizeStyle({ frame: { mode: "duo" } }).frame.cams, [], "older styles get no extra webcams");
});

test("game UI templates: the game UI pinned uncropped, with the webcam in a bottom corner for the enhanced one", async () => {
  const { defaultStyle, uiPlacement, facecamPlacement, filterGraph, templateOf, UI_TOP } = await import("../edit.mjs");
  const hook = { text: "", seconds: 3, color: "#111111", bg: "#ffffff" };
  const plain = defaultStyle({ framing: "gameUi" }), cam = defaultStyle({ framing: "gameUiCam" });
  assert.deepEqual([templateOf(plain.frame), templateOf(cam.frame)], ["gameUi", "gameUiCam"]);
  const ui = { x: 0.35, y: 0.82, w: 0.3, h: 0.16 };
  const p = uiPlacement({ ...plain.frame, ui }, 1280, 720);
  assert.equal(p.y, UI_TOP);
  assert.ok(Math.abs(p.w / p.h - (0.3 * 1280) / (0.16 * 720)) < 0.03, "its own shape");
  assert.ok(p.w <= 648 && p.h <= 1280 * 0.22 + 1);
  assert.equal(p.x, (720 - p.w) / 2);
  const g = filterGraph({ ...plain, frame: { ...plain.frame, ui }, trim: { start: 0, end: 8 }, hook }, { width: 1280, height: 720 }, null);
  assert.match(g, /split=2\[g\]\[u\]/);
  assert.match(g, /\[game\]\[ui\]overlay=\d+:300\[gu\]/);
  assert.match(filterGraph({ ...plain, trim: { start: 0, end: 8 }, hook }, { width: 1280, height: 720 }, null), /null\[g\].*\[game\]null\[v0\]/, "no UI box yet: just the game");
  const box = { x: 0.7, y: 0.05, w: 0.28, h: 0.4 }, cf = { ...cam.frame, ui, facecam: { ...cam.frame.facecam, box } };
  const fp = facecamPlacement(cf, 1280, 720);
  assert.equal(fp.y + fp.h, 1280 - 230, "in a bottom corner, clear of the UI");
  assert.match(filterGraph({ ...cam, frame: cf, trim: { start: 0, end: 8 }, hook }, { width: 1280, height: 720 }, null), /split=3\[g\]\[u\]\[c\].*\[gu\]\[cam\]overlay/);
});

test("withTextStyle keeps the subtitle height only between the same template", async () => {
  const { withTextStyle, defaultStyle, defaultEdit } = await import("../edit.mjs");
  const top = defaultEdit(defaultStyle({ framing: "cam" }), { trimStart: 0, trimEnd: 10 }), bottom = defaultStyle({ framing: "camBottom" });
  assert.equal(withTextStyle(top, bottom).captions.y, top.captions.y, "Bottom split's seam isn't copied onto Top split");
  assert.equal(withTextStyle(top, { ...defaultStyle({ framing: "cam" }), captions: { ...defaultStyle({ framing: "cam" }).captions, y: 0.4 } }).captions.y, 0.4);
});
