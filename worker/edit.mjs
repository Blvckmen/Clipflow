// The clip edit model, shared by the dashboard editor (live canvas preview) and the worker (ffmpeg render), so
// what the editor shows is laid out by the same numbers the render uses. Pure functions only: no Node or DOM APIs.
//
// An edit describes how to turn a clip's *source* (the captured moment plus a few seconds either side, unframed)
// into the published clip: 720x1280 (9:16) unless frame.aspect picks another shape (see ASPECTS). Times are seconds from the start of the source.
//   { v, trim:{start,end}, frame:{mode,zoom,x,y,background}, look:{brightness,contrast,saturation},
//     captions:{on,preset,font,size,color,highlight,outline,outlineColor,box,boxColor,uppercase,animation,words,y,mask,keywords,keywordColor},
//     hook:{text,seconds,color,bg,x,y,size}, progress:{on,color}, pace:{cuts,zooms}, chat:{on,y}, words?:[[start,end,text],...] }
// A *style* is the reusable part of an edit (everything except trim, hook text and words; it includes how long the
// hook stays up). Hook seconds at or past the clip's length keep the hook up for the whole clip. Each streamer can have
// its own style, so every new clip from that streamer comes out with that streamer's look.

export const W = 720, H = 1280;
// Clip shapes: the output size of each. All are about the same number of pixels (so renders take about as long and
// caption sizes, which are in pixels, look about the same). Portrait 9:16 is the default (TikTok, Reels, Shorts).
export const ASPECTS = { "9:16": [720, 1280], "4:5": [864, 1080], "1:1": [960, 960], "16:9": [1280, 720] };
export const ASPECT_LABELS = { "9:16": "Portrait 9:16", "4:5": "Portrait 4:5", "1:1": "Square 1:1", "16:9": "Landscape 16:9" };
// The output size of a clip with this frame.
export const canvas = frame => { const [w, h] = ASPECTS[frame?.aspect] ?? ASPECTS["9:16"]; return { W: w, H: h }; };
// Split screen and facecam-on-top stack two pictures, so they need a frame at least as tall as it is wide.
export const stacks = frame => { const c = canvas(frame); return c.H >= c.W; };
export const FONTS = ["Arial", "Impact", "Verdana", "Trebuchet MS", "Georgia", "Comic Sans MS", "DejaVu Sans"];
// "split": the stream fills part of the frame and a background (a looping video or a still image from the workspace's
// library) the rest. frame.split: share (the stream's part of the height, 0.3-0.8), top ("stream" or "background":
// which is on top), divider (a #rrggbb line on the seam, or null) and volume (the background video's sound, 0-1). frame.background is a library video's id, "clip:<id>" for another gallery clip, or null to let the worker
// pick a library video for the clip (the same one each time it renders that clip). Only videos at least as long as
// the clip are used; longer ones are cut to its length. frame.pool narrows that pick to some library backgrounds (a
// streamer's own set, chosen in Settings); empty means the whole library.
// "cam": the streamer's webcam (frame.facecam.box, a rectangle of the stream as fractions) across the top
// (facecam.share of the height) and the stream cut to fill the rest. "pip": the stream fills the frame and the webcam
// sits in a bordered box in a corner (facecam.corner, facecam.size of the width). Without a box both render as "blur".
// "phone": a stream filmed on a phone (common on Twitch and Kick IRL streams), an upright picture with black bars
// either side of a landscape stream. frame.content is that picture's rectangle (fractions of the stream, found by the
// worker); it is cut out and fills the frame. Without one, an upright 9:16 picture in the middle is assumed.
// facecam.place puts the "cam" strip at the top or the bottom; facecam.shape draws the "pip" webcam as a box or a circle.
export const FRAMINGS = ["blur", "crop", "fit", "split", "cam", "pip", "phone"];
export const CORNERS = ["tl", "tr", "bl", "br"];
export const CAM_PLACES = ["top", "bottom"], CAM_SHAPES = ["box", "circle"];
export const DEFAULT_FACECAM = { box: null, share: 0.35, corner: "tr", size: 0.36, place: "top", shape: "box" };
// Templates: a framing plus the facecam choices that make it look the way its name says. The id is what the workspace
// saves as its framing; the clip editor shows them as a gallery.
export const TEMPLATES = [
  { id: "cam", label: "Top split", mode: "cam", facecam: { place: "top" } },
  { id: "camBottom", label: "Bottom split", mode: "cam", facecam: { place: "bottom" } },
  { id: "blur", label: "Blurred", mode: "blur" },
  { id: "pip", label: "Small facecam", mode: "pip", facecam: { shape: "box" } },
  { id: "circle", label: "Circle facecam", mode: "pip", facecam: { shape: "circle" } },
  { id: "crop", label: "Full screen", mode: "crop" },
  { id: "fit", label: "Fit", mode: "fit" },
  { id: "split", label: "Background video", mode: "split" },
  { id: "phone", label: "Phone stream", mode: "phone" },
];
export const TEMPLATE_IDS = TEMPLATES.map(t => t.id);
// The template a frame matches (its mode, and for the facecam ones where the webcam goes).
export function templateOf(frame) {
  const fc = { ...DEFAULT_FACECAM, ...(frame?.facecam ?? {}) };
  return TEMPLATES.find(t => t.mode === frame?.mode && Object.entries(t.facecam ?? {}).every(([k, v]) => fc[k] === v))?.id ?? frame?.mode;
}
export const ANIMATIONS = ["none", "pop", "karaoke", "word"];
export const MIN_CLIP = 5, MAX_CLIP = 90;
// How much bigger a caption keyword is drawn (see keywordScore).
export const KEYWORD_SCALE = 1.15;
// How long a hook title stays up unless the look says otherwise; up to the whole clip.
export const DEFAULT_HOOK_SECONDS = 5;
export const DEFAULT_SPLIT = { share: 0.5, top: "stream", divider: null, volume: 0 };
export const SPLIT_TOPS = ["stream", "background"];
// Pace: pace.cuts takes quiet pauses out of the speech ("gentle" or "tight" jump cuts), pace.zooms punches in on the
// loudest moments. Neither is stored as a list: both are worked out from the transcript and the source's per-second
// loudness by timeline(), the same way in the editor and in the render.
export const CUT_LEVELS = ["off", "gentle", "tight"];
export const DEFAULT_PACE = { cuts: "off", zooms: false };
// Chat on the clip: chat.on shows the Twitch chat messages sent during the clip (the clip's signals.messages), the
// newest CHAT_LINES at a time, each for up to CHAT_HOLD seconds, in a column on the left whose bottom is chat.y down.
export const DEFAULT_CHAT = { on: false, y: 0.62 };
// Background music, to avoid copyright claims: audio.music "keep" (as recorded), "lower" (the voice at full volume,
// everything else - music and game sound - turned down to MUSIC_LEVEL) or "voice" (the voice alone). The worker splits
// the voice from the rest with Demucs (worker/music.mjs) before rendering.
export const MUSIC_MODES = ["keep", "lower", "voice"];
export const DEFAULT_AUDIO = { music: "keep" };
export const MUSIC_LEVEL = 0.2;
export const CHAT_LINES = 4, CHAT_HOLD = 8, CHAT_SIZE = 30;

// Caption looks. Picking a preset copies its values; every value can then be changed on its own. keywordColor is the
// colour that makes a line's most important word stand out (captions.keywords, see keywordScore).
export const PRESETS = {
  clean: { label: "Clean", font: "Arial", size: 54, color: "#ffffff", highlight: "#ffffff", outline: 4, outlineColor: "#000000", box: false, boxColor: "#000000", uppercase: false, animation: "none", words: 4, keywordColor: "#ffe14d" },
  bold: { label: "Bold pop", font: "Impact", size: 74, color: "#ffffff", highlight: "#ffe14d", outline: 6, outlineColor: "#000000", box: false, boxColor: "#000000", uppercase: true, animation: "pop", words: 3, keywordColor: "#ffe14d" },
  karaoke: { label: "Karaoke", font: "Arial", size: 60, color: "#ffffff", highlight: "#bcfa76", outline: 5, outlineColor: "#000000", box: false, boxColor: "#000000", uppercase: false, animation: "karaoke", words: 4, keywordColor: "#ffe14d" },
  boxed: { label: "Boxed", font: "Verdana", size: 46, color: "#111111", highlight: "#e0245e", outline: 0, outlineColor: "#000000", box: true, boxColor: "#ffffff", uppercase: false, animation: "karaoke", words: 5, keywordColor: "#1d4ed8" },
  neon: { label: "Neon", font: "Trebuchet MS", size: 62, color: "#7df9ff", highlight: "#ff4fd8", outline: 3, outlineColor: "#1a0033", box: false, boxColor: "#000000", uppercase: true, animation: "karaoke", words: 3, keywordColor: "#fff35c" },
  single: { label: "One word", font: "Impact", size: 96, color: "#ffffff", highlight: "#ffffff", outline: 7, outlineColor: "#000000", box: false, boxColor: "#000000", uppercase: true, animation: "word", words: 1, keywordColor: "#ffe14d" },
};

export function defaultStyle({ framing = "blur", captions = true } = {}) {
  const preset = { ...PRESETS.bold };
  delete preset.label;
  // framing is a template id (the plain framings are templates too).
  const t = TEMPLATES.find(x => x.id === framing) ?? TEMPLATES.find(x => x.id === "blur"), facecam = { ...DEFAULT_FACECAM, ...(t.facecam ?? {}) };
  const seam = t.mode === "split" ? 0.5 : t.mode === "cam" ? (facecam.place === "bottom" ? 1 - facecam.share : facecam.share) : 0.72;
  return {
    frame: { mode: t.mode, aspect: "9:16", zoom: 1, x: 0, y: 0, content: null, background: null, pool: [], split: { ...DEFAULT_SPLIT }, facecam },
    look: { brightness: 1, contrast: 1, saturation: 1 },
    // Split screen and the facecam strip put captions on the seam between the two pictures.
    captions: { on: !!captions, preset: "bold", ...preset, keywords: true, y: seam, mask: false },
    hook: { color: "#111111", bg: "#ffffff", seconds: DEFAULT_HOOK_SECONDS, ...HOOK_DEFAULT },
    progress: { on: false, color: "#bcfa76" },
    chat: { ...DEFAULT_CHAT },
    audio: { ...DEFAULT_AUDIO },
    pace: { ...DEFAULT_PACE },
  };
}

class EditError extends Error {}
const fail = message => { throw new EditError(message); };
const num = (v, min, max, name) => { if (typeof v !== "number" || !Number.isFinite(v)) fail(name + " must be a number"); return Math.min(max, Math.max(min, v)); };
const int = (v, min, max, name) => Math.round(num(v, min, max, name));
const bool = (v, name) => { if (typeof v !== "boolean") fail(name + " must be true or false"); return v; };
// A hook without a background (hook.bg null) gets an outline that contrasts with its text: black around light text,
// white around dark text.
export const HOOK_OUTLINE = 5;
// Where the hook sits: x is its centre and y its top, as fractions of the frame; size is its text size in pixels.
// x stays in the middle half so a line always has room to wrap.
export const HOOK_X = [0.25, 0.75], HOOK_Y = [0.02, 0.9], HOOK_SIZE = [28, 120], HOOK_DEFAULT = { x: 0.5, y: 0.117, size: 52 };
// The hook's anchor in pixels and the side margins that give it the same wrap width either side of its centre.
export function hookPlacement(edit) {
  const { W, H } = canvas(edit.frame), h = { ...HOOK_DEFAULT, ...edit.hook };
  const x = Math.round(h.x * W), margin = Math.round(W / 2 - Math.min(x, W - x) + 60);
  return { x, y: Math.round(h.y * H), size: h.size, margin, wrap: W - 2 * margin };
}
export function hookOutlineColor(text) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(text.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5 ? "#000000" : "#ffffff";
}
const color = (v, name) => { if (typeof v !== "string" || !/^#[0-9a-f]{6}$/i.test(v)) fail(name + " must be a #rrggbb colour"); return v.toLowerCase(); };
const pick = (v, list, name) => { if (!list.includes(v)) fail(name + " is not a supported value"); return v; };
// Hook text keeps the line breaks typed in the editor: at most HOOK_LINES lines, without empty ones.
export const HOOK_LINES = 3;
const hookText = v => { if (typeof v !== "string") fail("Hook text must be text"); return v.replace(/[{}\\]/g, "").split(/\r?\n/).map(l => l.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, HOOK_LINES).join("\n").slice(0, 90).trim(); };
const text = (v, max, name) => { if (typeof v !== "string") fail(name + " must be text"); return v.replace(/[\r\n]+/g, " ").replace(/[{}\\]/g, "").slice(0, max); };
const obj = (v, name) => { if (!v || typeof v !== "object" || Array.isArray(v)) fail(name + " is missing"); return v; };
// The webcam's rectangle in the stream, as fractions of its width and height (null: not set).
const camBox = (v, what = "Facecam") => {
  if (v === null || v === undefined) return null;
  const b = obj(v, what + " box"), w = num(b.w, 0.05, 1, what + " width"), h = num(b.h, 0.05, 1, what + " height");
  return { x: num(b.x, 0, 1 - w, what + " left"), y: num(b.y, 0, 1 - h, what + " top"), w, h };
};
// A background video: a library video's id, or "clip:<id>" for another clip from the gallery.
// A list of library background ids (no gallery clips), at most 30, without repeats.
const pool = v => { if (v === undefined || v === null) return []; if (!Array.isArray(v) || v.length > 30) fail("Background set is not valid"); return [...new Set(v.map(x => { const id = ref(x, "Background set"); if (!id || id.startsWith("clip:")) fail("Background set is not valid"); return id; }))]; };
const ref = (v, name) => { if (v === null || v === undefined) return null; if (typeof v !== "string" || !/^(clip:)?[0-9a-f-]{36}$/i.test(v)) fail(name + " is not valid"); return v.toLowerCase(); };

// Validates a style from an untrusted client (or an older saved one), filling any missing part from the defaults.
export function normalizeStyle(input, base = defaultStyle()) {
  const s = obj(input, "Style");
  const f = { ...base.frame, ...(s.frame ?? {}) }, sp = { ...DEFAULT_SPLIT, ...(base.frame.split ?? {}), ...(s.frame?.split ?? {}) }, l = { ...base.look, ...(s.look ?? {}) }, c = { ...base.captions, ...(s.captions ?? {}) };
  const h = { ...base.hook, ...(s.hook ?? {}) }, p = { ...base.progress, ...(s.progress ?? {}) }, pc = { ...DEFAULT_PACE, ...(base.pace ?? {}), ...(s.pace ?? {}) };
  const fc = { ...DEFAULT_FACECAM, ...(base.frame.facecam ?? {}), ...(s.frame?.facecam ?? {}) };
  const ch = { ...DEFAULT_CHAT, ...(base.chat ?? {}), ...(s.chat ?? {}) };
  const au = { ...DEFAULT_AUDIO, ...(base.audio ?? {}), ...(s.audio ?? {}) };
  const aspect = pick(f.aspect ?? "9:16", Object.keys(ASPECTS), "Clip shape");
  // A landscape clip has no room to stack two pictures: split screen and facecam-on-top become the blurred fill.
  const mode = pick(f.mode, FRAMINGS, "Framing"), fits = stacks({ aspect }) || (mode !== "split" && mode !== "cam");
  return {
    frame: { mode: fits ? mode : "blur", aspect, content: camBox(f.content, "Phone picture"), zoom: num(f.zoom, 1, 3, "Zoom"), x: num(f.x, -1, 1, "Horizontal position"), y: num(f.y, -1, 1, "Vertical position"), background: ref(f.background, "Background video"), pool: pool(f.pool),
      split: { share: num(sp.share, 0.3, 0.8, "Stream share"), top: pick(sp.top, SPLIT_TOPS, "Split order"), divider: sp.divider === null ? null : color(sp.divider, "Divider colour"), volume: num(sp.volume, 0, 1, "Background volume") },
      facecam: { box: camBox(fc.box), share: num(fc.share, 0.2, 0.5, "Facecam height"), corner: pick(fc.corner, CORNERS, "Facecam corner"), size: num(fc.size, 0.2, 0.5, "Facecam size"),
        place: pick(fc.place, CAM_PLACES, "Facecam place"), shape: pick(fc.shape, CAM_SHAPES, "Facecam shape") } },
    look: { brightness: num(l.brightness, 0.5, 1.5, "Brightness"), contrast: num(l.contrast, 0.5, 1.5, "Contrast"), saturation: num(l.saturation, 0, 2, "Saturation") },
    captions: {
      on: bool(c.on, "Captions"), preset: typeof c.preset === "string" && PRESETS[c.preset] ? c.preset : "custom",
      font: pick(c.font, FONTS, "Font"), size: int(c.size, 24, 140, "Caption size"), color: color(c.color, "Caption colour"), highlight: color(c.highlight, "Highlight colour"),
      outline: int(c.outline, 0, 12, "Outline"), outlineColor: color(c.outlineColor, "Outline colour"), box: bool(c.box, "Caption box"), boxColor: color(c.boxColor, "Box colour"),
      uppercase: bool(c.uppercase, "Uppercase"), animation: pick(c.animation, ANIMATIONS, "Animation"), words: int(c.words, 1, 8, "Words per line"), y: num(c.y, 0.08, 0.95, "Caption position"), mask: bool(c.mask, "Profanity filter"),
      // Looks saved before keyword highlighting get it on, in their preset's colour.
      keywords: bool(c.keywords ?? true, "Keyword highlight"), keywordColor: color(s.captions?.keywordColor ?? PRESETS[c.preset]?.keywordColor ?? c.keywordColor ?? "#ffe14d", "Keyword colour"),
    },
    // on: whether the hook is shown; off keeps its text for turning it back on (edits from before it: shown).
    hook: { on: bool(h.on ?? true, "Opening title"), color: color(h.color, "Hook text colour"), bg: h.bg === null ? null : color(h.bg, "Hook background"), seconds: num(h.seconds ?? DEFAULT_HOOK_SECONDS, 1, MAX_CLIP, "Hook length"),
      x: num(h.x ?? HOOK_DEFAULT.x, ...HOOK_X, "Hook position"), y: num(h.y ?? HOOK_DEFAULT.y, ...HOOK_Y, "Hook position"), size: int(h.size ?? HOOK_DEFAULT.size, ...HOOK_SIZE, "Hook size") },
    progress: { on: bool(p.on, "Progress bar"), color: color(p.color, "Progress bar colour") },
    pace: { cuts: pick(pc.cuts, CUT_LEVELS, "Jump cuts"), zooms: bool(pc.zooms, "Punch-in zooms") },
    chat: { on: bool(ch.on, "Chat on the clip"), y: num(ch.y, 0.15, 0.95, "Chat position") },
    audio: { music: pick(au.music, MUSIC_MODES, "Background music") },
  };
}

export function styleOf(edit) {
  const { frame, look, captions, hook, progress, pace = { ...DEFAULT_PACE }, chat = { ...DEFAULT_CHAT }, audio = { ...DEFAULT_AUDIO } } = edit;
  return { frame, look, captions, hook: { on: hook.on !== false, color: hook.color, bg: hook.bg, seconds: hook.seconds, x: hook.x, y: hook.y, size: hook.size }, progress, pace, chat, audio };
}
// Whether an edit shows its hook: switched on and with text.
export const showsHook = edit => edit.hook?.on !== false && !!edit.hook?.text;
// The subtitle and hook look of `source` (a style or edit) applied to `edit`, keeping what is the clip's own: the
// hook's text, whether each is switched on, and the subtitle height when the two are framed differently (it follows
// the framing's seam).
export function withTextStyle(edit, source) {
  const s = normalizeStyle(source), sameFrame = s.frame.mode === edit.frame.mode;
  return { ...edit, captions: { ...s.captions, on: edit.captions.on, y: sameFrame ? s.captions.y : edit.captions.y },
    hook: { ...s.hook, on: edit.hook.on !== false, text: edit.hook.text ?? "", seconds: Math.min(s.hook.seconds, MAX_CLIP) } };
}

// A first edit for a freshly captured clip: the chosen moment, in the streamer's (or workspace's) style.
export function defaultEdit(style, { trimStart, trimEnd }) {
  const s = normalizeStyle(style ?? defaultStyle());
  return { v: 1, trim: { start: round(trimStart), end: round(trimEnd) }, ...s, hook: { text: "", ...s.hook } };
}

// Validates a whole edit against the clip's source length. Throws EditError with a readable message.
export function normalizeEdit(input, { duration }) {
  const e = obj(input, "Edit"), t = obj(e.trim, "Trim");
  const total = num(duration, 1, 600, "Source length");
  const start = num(t.start, 0, total, "Trim start"), end = num(t.end, 0, total, "Trim end");
  if (end - start < MIN_CLIP - 0.01) fail("A clip must be at least " + MIN_CLIP + " seconds long");
  if (end - start > MAX_CLIP + 0.01) fail("A clip can be at most " + MAX_CLIP + " seconds long");
  const style = normalizeStyle(e);
  const hook = obj(e.hook ?? {}, "Hook");
  const out = { v: 1, trim: { start: round(start), end: round(end) }, ...style, hook: { ...style.hook, text: hookText(hook.text ?? ""), seconds: num(hook.seconds ?? style.hook.seconds, 1, MAX_CLIP, "Hook length") } };
  if (e.words !== undefined) out.words = normalizeWords(e.words, total);
  return out;
}

// Transcript words: [[start, end, text]], seconds from the source start. Empty text hides a word from captions.
export function normalizeWords(words, total = 600) {
  if (!Array.isArray(words) || words.length > 2000) fail("Transcript is invalid");
  return words.map(w => {
    if (!Array.isArray(w) || w.length !== 3) fail("Transcript is invalid");
    const s = num(w[0], 0, total, "Word start"), e = num(w[1], s, total, "Word end");
    return [round(s), round(e), text(w[2], 40, "Word").trim()];
  });
}

const round = n => Math.round(n * 100) / 100;
const even = n => Math.max(2, 2 * Math.round(n / 2));

// Where the picture sits on the 720x1280 canvas. Crop covers the frame, fit and blur fit inside it; zoom enlarges,
// and x/y (-1..1) slide the picture across whatever room the zoom leaves. Split screen covers the top half (the
// picture is cut off at the seam: `area` is the region it is clipped to).
export const SPLIT_H = H / 2;
// Split screen's two parts: where the stream and the background sit (y and height, whole even pixels), and the seam.
export function splitAreas(frame) {
  const { H } = canvas(frame);
  const sp = { ...DEFAULT_SPLIT, ...(frame?.split ?? {}) };
  const streamH = even(H * Math.min(0.8, Math.max(0.3, sp.share))), bgH = H - streamH, streamTop = sp.top !== "background";
  return { stream: { y: streamTop ? 0 : bgH, h: streamH }, background: { y: streamTop ? streamH : 0, h: bgH }, seam: streamTop ? streamH : bgH };
}
// Facecam + game: the webcam strip across the top (or the bottom, facecam.place) and the game in the rest.
export function camAreas(frame) {
  const { H } = canvas(frame);
  const camH = even(H * Math.min(0.5, Math.max(0.2, frame.facecam?.share ?? DEFAULT_FACECAM.share)));
  if (frame.facecam?.place === "bottom") return { cam: { y: H - camH, h: camH }, game: { y: 0, h: H - camH }, seam: H - camH };
  return { cam: { y: 0, h: camH }, game: { y: camH, h: H - camH }, seam: camH };
}
// The white ring around a circle facecam, in pixels.
export const RING = 6;
// Where the webcam is cut from the stream (sx, sy, sw, sh in source pixels) and drawn on the canvas (x, y, w, h):
// across the top in "cam" mode (cut to that strip's shape, centred on the box), or as a corner box in "pip" mode
// (the box's own shape, frame.facecam.size of the width, kept clear of the hook at the top and captions low down).
export const PIP_MARGIN = 28, PIP_TOP = 170, PIP_BOTTOM = 230;
export function facecamPlacement(frame, width, height) {
  const fc = { ...DEFAULT_FACECAM, ...(frame.facecam ?? {}) }, b = fc.box, { W, H } = canvas(frame);
  if (!b) return null;
  const SW = width > 0 ? width : 1280, SH = height > 0 ? height : 720;
  let sx = b.x * SW, sy = b.y * SH, bw = b.w * SW, bh = b.h * SH;
  if (frame.mode === "cam") {
    const { cam } = camAreas(frame), want = W / cam.h;
    // Cut the box to the strip's shape, staying inside it: centred sideways, and trimmed mostly from the bottom (the
    // face sits in the upper part of a head-and-shoulders box; what's below is often the stream's own UI).
    if (bw / bh > want) { const nw = bh * want; sx += (bw - nw) / 2; bw = nw; } else { const nh = bw / want; sy += (bh - nh) * 0.25; bh = nh; }
    return { sx: Math.round(sx), sy: Math.round(sy), sw: even(bw), sh: even(bh), x: 0, y: cam.y, w: W, h: cam.h };
  }
  // A circle shows a square cut of the box: centred sideways, trimmed mostly from the bottom like the strip.
  if (fc.shape === "circle") { if (bw > bh) { sx += (bw - bh) / 2; bw = bh; } else { sy += (bh - bw) * 0.25; bh = bw; } }
  const w = even(W * fc.size), h = fc.shape === "circle" ? w : even(w * bh / bw);
  const x = fc.corner.endsWith("l") ? PIP_MARGIN : W - PIP_MARGIN - w, y = Math.max(PIP_MARGIN, fc.corner.startsWith("t") ? PIP_TOP : H - PIP_BOTTOM - h);
  return { sx: Math.round(sx), sy: Math.round(sy), sw: even(bw), sh: even(bh), x, y, w, h };
}
// The phone picture inside the stream, in stream pixels: frame.content, or an upright 9:16 picture in the middle.
export function phoneBox(frame, width, height) {
  const SW = width > 0 ? width : 1280, SH = height > 0 ? height : 720, b = frame.content;
  // Even pixels (yuv420p crops need them); positions may be 0, sizes stay inside the stream.
  const at = n => 2 * Math.floor(n / 2);
  if (b) { const x = at(b.x * SW), y = at(b.y * SH); return { x, y, w: Math.min(even(b.w * SW), at(SW - x)), h: Math.min(even(b.h * SH), at(SH - y)) }; }
  const w = Math.min(at(SW), even(SH * 9 / 16));
  return { x: at((SW - w) / 2), y: 0, w, h: at(SH) };
}
// src: the part of the stream that is shown (all of it, or the phone picture), in stream pixels.
export function layout(frame, width, height) {
  const fw = width > 0 ? width : 1280, fh = height > 0 ? height : 720, { W, H } = canvas(frame);
  const src = frame.mode === "phone" ? phoneBox(frame, fw, fh) : { x: 0, y: 0, w: fw, h: fh }, sw = src.w, sh = src.h;
  const cam = frame.mode === "cam" && frame.facecam?.box ? camAreas(frame) : null;
  const areas = frame.mode === "split" ? splitAreas(frame) : cam ? { stream: cam.game } : null;
  const AW = W, AH = areas ? areas.stream.h : H;
  const base = ["crop", "split", "cam", "pip", "phone"].includes(frame.mode) ? Math.max(AW / sw, AH / sh) : Math.min(AW / sw, AH / sh);
  const w = even(sw * base * frame.zoom), h = even(sh * base * frame.zoom);
  return { w, h, x: Math.round((AW - w) / 2 + frame.x * Math.abs(AW - w) / 2), y: Math.round((AH - h) / 2 + frame.y * Math.abs(AH - h) / 2), area: { w: AW, h: AH, y: areas ? areas.stream.y : 0 }, src };
}

const SWEAR = /^(fuck|shit|bitch|cunt|dick|puss|asshole|bastard|cock|slut|whore|fag|nigg|motherf)/i;
export function maskWord(word) {
  const bare = word.replace(/[^\p{L}\p{N}']/gu, "");
  if (!SWEAR.test(bare)) return word;
  let seen = false;
  return word.replace(/[\p{L}\p{N}]/gu, ch => { if (!seen) { seen = true; return ch; } return "*"; });
}

// ---- Keywords: the word in a caption line that matters most, drawn in captions.keywordColor and a little bigger ----
const STOP = new Set("a an the and or but so if then than that this these those there here it its it's is am are was were be been being do does did done have has had having i me my mine you your yours he him his she her hers we us our they them their what which who whom whose when where why how all any both each few more most other some such no nor not only own same too very can will just don't should now to of in on at by for with about against between into through during before after above below from up down out off over under again further once also yeah yes ok okay oh uh um like gonna wanna gotta really actually got get go going went know think mean said say says thing things".split(" "));
const EMPHATIC = new Set("insane crazy never always wait stop huge massive biggest best worst ever impossible unbelievable incredible literally dead died kill killed win won winning lose lost losing first last million billion thousand hundred free broke rich money secret shocked crying screaming insanely perfect legendary clutch ace banned destroyed".split(" "));
// How strongly a word should stand out (0: never). first: it starts the caption line, where a capital means nothing.
export function keywordScore(raw, first = false) {
  const word = String(raw).replace(/^[^\p{L}\p{N}$£€]+|[^\p{L}\p{N}%!?]+$/gu, ""), bare = word.toLowerCase().replace(/[!?]+$/, "");
  if (!bare) return 0;
  if (/\d/.test(bare) || /^[$£€]/.test(bare)) return 5;  // numbers and amounts matter most
  if (STOP.has(bare) || bare.length < 3) return 0;
  let score = 1 + (bare.length >= 6 ? 1 : 0);
  if (EMPHATIC.has(bare)) score += 3;
  const letters = word.replace(/[^\p{L}]/gu, "");
  if (letters.length >= 2 && letters === letters.toUpperCase() && letters !== letters.toLowerCase()) score += 2;  // shouted
  else if (!first && /^\p{Lu}/u.test(word)) score += 1;  // a name, mid-sentence
  if (/!$/.test(word)) score += 1;
  return score;
}
// Which words of a caption line stand out: the top-scoring one (two on lines of 5+ words), if it scores at least 3.
export function keywordsOf(texts) {
  const scored = texts.map((t, i) => ({ i, s: keywordScore(t, i === 0) })).filter(x => x.s >= 3).sort((a, b) => b.s - a.s || a.i - b.i);
  return new Set(scored.slice(0, texts.length >= 5 ? 2 : 1).map(x => x.i));
}

// Groups transcript words inside the trim into caption cues, with times relative to the trimmed clip.
// Breaks on the words-per-line setting, long lines, pauses, long cues and sentence ends.
export function cues(words, edit) {
  const c = edit.captions, { start, end } = edit.trim, perLine = c.words, maxChars = Math.max(10, perLine * 9);
  const out = [];
  let cur = [];
  const flush = () => { if (cur.length) out.push(cur); cur = []; };
  for (const [ws, we, raw] of words ?? []) {
    if (!raw || ws < start - 0.05 || we > end + 0.05) continue;
    let t = c.mask ? maskWord(raw) : raw;
    if (c.uppercase) t = t.toUpperCase();
    const s = Math.max(0, ws - start), e = Math.min(end - start, we - start);
    if (cur.length && (cur.length >= perLine || cur.map(w => w.t).join(" ").length + 1 + t.length > maxChars || s - cur.at(-1).e > 0.6 || e - cur[0].s > 2.5)) flush();
    // Keywords are judged on `raw` (before ALL CAPS): shouting only counts when it was really said in capitals.
    cur.push({ s, e, t, raw });
    if (/[.?!]$/.test(t)) flush();
  }
  flush();
  return out.map((ws, i) => {
    const next = out[i + 1];
    let e = Math.max(ws.at(-1).e, ws[0].s + 0.4);
    if (next) e = Math.min(e, next[0].s);
    // k: this word is the line's keyword (captions.keywords on).
    const keys = c.keywords ? keywordsOf(ws.map(w => w.raw)) : new Set();
    return { start: ws[0].s, end: e, words: ws.map(({ raw: _raw, ...w }, j) => ({ ...w, k: keys.has(j) })) };
  });
}

// The cue on screen at time t (seconds into the trimmed clip), and which of its words is being spoken.
export function activeCue(list, t) {
  const cue = list.find(c => t >= c.start && t < c.end);
  if (!cue) return null;
  let word = 0;
  cue.words.forEach((w, i) => { if (t >= w.s) word = i; });
  return { cue, word };
}

// ---- Pace: jump cuts and punch-in zooms ----
// A pause between two spoken words is cut when it is at least `gap` seconds long and quiet (no second inside it
// reaches QUIET of the source's loudest second: a pause full of game sound or shouting is kept). `pad` seconds of
// it stay either side so words don't get clipped. Without loudness (older clips) only pauses up to 1.2s are cut.
// Cuts stop before the clip would get shorter than MIN_CLIP. Only pauses *between* words go: the clip's opening and
// ending, often action without talking, are always kept.
const CUT_SIZES = { gentle: { gap: 0.8, pad: 0.25 }, tight: { gap: 0.45, pad: 0.12 } };
export const QUIET = 0.3;
const quietBetween = (energy, a, b) => {
  if (!Array.isArray(energy) || !energy.length) return b - a <= 1.2;
  // The seconds whose middle falls inside the pause (a short pause may have none: it is quiet).
  for (let i = Math.max(0, Math.ceil(a - 0.5)); i + 0.5 <= b; i++) if ((energy[i] ?? 0) >= QUIET) return false;
  return true;
};
// Spans taken out of the clip, as [from, to] seconds into the trimmed clip, in order.
export function jumpCuts(edit, words, energy) {
  const size = CUT_SIZES[edit.pace?.cuts];
  if (!size) return [];
  const { start, end } = edit.trim, len = end - start;
  const said = (words ?? []).filter(w => w[0] >= start - 0.05 && w[1] <= end + 0.05).sort((x, y) => x[0] - y[0]);
  const out = [];
  let removed = 0, spoken = said[0]?.[1] ?? 0;
  for (let i = 1; i < said.length; i++) {
    const before = spoken, next = said[i][0], a = before + size.pad, b = next - size.pad;
    spoken = Math.max(spoken, said[i][1]);
    if (next - before < size.gap || b - a < 0.2 || !quietBetween(energy, a, b)) continue;
    if (len - removed - (b - a) < MIN_CLIP) break;
    out.push([round(a - start), round(b - start)]);
    removed += round(b - start) - round(a - start);
  }
  return out;
}
// Punch-ins: the picture zooms in by PUNCH.zoom over `rise` seconds, holds, and eases back out over `fall`.
export const PUNCH = { zoom: 0.14, rise: 0.15, hold: 1.1, fall: 0.4 };
// The loudest moments (a second at least 75% as loud as the loudest, and louder than the seconds either side), at
// least 5s apart, not in the first second, about one per 8s of clip (1-6). Times are seconds into the finished clip.
function punchTimes(edit, energy, cuts, toClip, length) {
  if (!edit.pace?.zooms || !Array.isArray(energy) || !energy.length) return [];
  const { start, end } = edit.trim, found = [], picks = [];
  for (let i = Math.ceil(start); i < end - 1; i++) {
    const e = energy[i] ?? 0;
    if (e >= 0.75 && e >= (energy[i - 1] ?? 0) && e >= (energy[i + 1] ?? 0)) found.push([i, e]);
  }
  found.sort((x, y) => y[1] - x[1] || x[0] - y[0]);
  const most = Math.max(1, Math.min(6, Math.round(length / 8)));
  for (const [i] of found) {
    const rel = i - start;
    if (rel < 1 || cuts.some(([a, b]) => rel >= a && rel < b)) continue;
    const t = round(toClip(rel));
    if (t > length - PUNCH.rise - PUNCH.hold || picks.some(p => Math.abs(p - t) < 5)) continue;
    picks.push(t);
    if (picks.length >= most) break;
  }
  return picks.sort((x, y) => x - y);
}
// How far the picture is zoomed (1 = not at all) at `t` seconds into the finished clip.
const ramp = (punches, t) => { let z = 0; for (const p of punches) z = Math.max(z, Math.min(1, Math.max(0, (t - p) / PUNCH.rise)) * Math.min(1, Math.max(0, (p + PUNCH.rise + PUNCH.hold + PUNCH.fall - t) / PUNCH.fall))); return z; };
export const zoomAt = (punches, t) => 1 + PUNCH.zoom * ramp(punches, t);
// The finished clip's timeline: the jump cuts (seconds into the trimmed source), its length after them, toClip (a
// time in the trimmed source to a time in the finished clip) and the punch-in times (finished clip).
export function timeline(edit, words, energy) {
  const cuts = jumpCuts(edit, words, energy), len = edit.trim.end - edit.trim.start;
  const length = round(len - cuts.reduce((n, [a, b]) => n + b - a, 0));
  const toClip = t => { let gone = 0; for (const [a, b] of cuts) { if (t >= b) gone += b - a; else if (t > a) gone += t - a; } return t - gone; };
  return { cuts, length, toClip, punches: punchTimes(edit, energy, cuts, toClip, length) };
}
const plain = edit => ({ cuts: [], length: edit.trim.end - edit.trim.start, toClip: t => t, punches: [] });

// ---- ASS subtitles for the render ----
// ASS colours are &HAABBGGRR with AA=00 opaque.
export function assColor(hex, alpha = 0) {
  const h = hex.replace("#", "");
  return "&H" + alpha.toString(16).padStart(2, "0").toUpperCase() + (h.slice(4, 6) + h.slice(2, 4) + h.slice(0, 2)).toUpperCase();
}
const clock = t => { const cs = Math.max(0, Math.round(t * 100)); return Math.floor(cs / 360000) + ":" + String(Math.floor(cs / 6000) % 60).padStart(2, "0") + ":" + String(Math.floor(cs / 100) % 60).padStart(2, "0") + "." + String(cs % 100).padStart(2, "0"); };
const esc = t => t.replace(/[{}\\]/g, "");
const POP = "{\\fscx82\\fscy82\\t(0,110,\\fscx100\\fscy100)}";

// ---- Chat on the clip ----
// A name colour for chatters who never picked one, the same for a name every time.
const CHAT_COLORS = ["#ff7a7a", "#7ab8ff", "#9cff7a", "#ffd27a", "#d17aff", "#7affe9", "#ff9fd6", "#ffb37a"];
export function chatColor(name, color) {
  if (color && /^#[0-9a-f]{6}$/i.test(color)) return color.toLowerCase();
  let h = 0; for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return CHAT_COLORS[h % CHAT_COLORS.length];
}
// What chat shows over time: [{ start, end, lines: [{ name, text, color }] }] in source seconds, oldest line first.
// `messages` are [time, name, text, color] (signals.messages). Each message shows from its time for CHAT_HOLD
// seconds or until CHAT_LINES newer ones push it out; long ones are shortened.
export function chatWindows(messages, edit) {
  if (!edit.chat?.on || !Array.isArray(messages) || !messages.length) return [];
  const { start, end } = edit.trim;
  const list = messages.filter(m => Array.isArray(m) && Number.isFinite(m[0]) && m[0] >= start - CHAT_HOLD && m[0] <= end && String(m[2] ?? "").trim())
    .sort((a, b) => a[0] - b[0])
    .map(([t, name, text, color]) => {
      let body = String(text).replace(/\s+/g, " ").trim();
      if (edit.captions?.mask) body = body.split(" ").map(maskWord).join(" ");
      // Lines don't wrap, so name and message together keep to about 44 characters (the frame's width at CHAT_SIZE).
      const who = String(name || "viewer").slice(0, 20), room = Math.max(12, 44 - who.length);
      return { t, name: who, text: body.length > room ? body.slice(0, room - 3) + "..." : body, color: chatColor(name, color) };
    });
  const points = [...new Set([start, end, ...list.flatMap(m => [m.t, m.t + CHAT_HOLD])].filter(t => t >= start && t <= end))].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i], b = points[i + 1];
    const lines = list.filter(m => m.t <= a && m.t + CHAT_HOLD > a).slice(-CHAT_LINES).map(({ name, text, color }) => ({ name, text, color }));
    if (!lines.length) continue;
    const last = out.at(-1);
    if (last && last.end === a && JSON.stringify(last.lines) === JSON.stringify(lines)) last.end = b;
    else out.push({ start: a, end: b, lines });
  }
  return out;
}

// `tl` (see timeline) moves every caption to its time in the finished clip, after any jump cuts.
// `messages`: the clip's chat (signals.messages), drawn when edit.chat.on.
export function buildAss(edit, words, tl = plain(edit), messages = []) {
  const { W, H } = canvas(edit.frame), c = edit.captions, len = tl.length, y = Math.round(c.y * H), at = tl.toClip, hp = hookPlacement(edit);
  const stamp = t => clock(at(t));
  const boxStyle = c.box ? { border: 3, outline: Math.max(8, Math.round(c.size * 0.22)), outlineColor: assColor(c.boxColor) } : { border: 1, outline: c.outline, outlineColor: assColor(c.outlineColor) };
  const lines = [
    "[Script Info]", "ScriptType: v4.00+", "PlayResX: " + W, "PlayResY: " + H, "WrapStyle: 0", "ScaledBorderAndShadow: yes", "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Cap,${c.font},${c.size},${assColor(c.color)},${assColor(c.highlight)},${boxStyle.outlineColor},${assColor("#000000", 0x80)},-1,0,0,0,100,100,0,0,${boxStyle.border},${boxStyle.outline},0,5,40,40,0,1`,
    `Style: Chat,Arial,${CHAT_SIZE},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,0,1,40,40,0,1`,
    edit.hook.bg
      ? `Style: Hook,${c.font},${hp.size},${assColor(edit.hook.color)},${assColor(edit.hook.color)},${assColor(edit.hook.bg)},${assColor("#000000", 0x80)},-1,0,0,0,100,100,0,0,3,${Math.round(hp.size * 14 / 52)},0,8,60,60,0,1`
      : `Style: Hook,${c.font},${hp.size},${assColor(edit.hook.color)},${assColor(edit.hook.color)},${assColor(hookOutlineColor(edit.hook.color))},${assColor("#000000", 0x80)},-1,0,0,0,100,100,0,0,1,${Math.max(3, Math.round(hp.size * HOOK_OUTLINE / 52))},0,8,60,60,0,1`,
    "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const pos = "{\\an5\\pos(" + W / 2 + "," + y + ")}";
  const hl = "{\\c" + assColor(c.highlight) + "}", base = "{\\c" + assColor(c.color) + "}";
  // A keyword: its own colour (the karaoke highlight while it's spoken) and KEYWORD_SCALE bigger.
  const big = "\\fscx" + Math.round(KEYWORD_SCALE * 100) + "\\fscy" + Math.round(KEYWORD_SCALE * 100);
  const kw = (x, now = false) => x.k ? "{\\c" + assColor(now ? c.highlight : c.keywordColor) + big + "}" + esc(x.t) + "{\\c" + assColor(c.color) + "\\fscx100\\fscy100}" : now ? hl + esc(x.t) + base : esc(x.t);
  if (c.on) for (const cue of cues(words, edit)) {
    if (c.animation === "word") {
      cue.words.forEach((w, i) => {
        const end = i + 1 < cue.words.length ? cue.words[i + 1].s : cue.end;
        lines.push(`Dialogue: 0,${stamp(w.s)},${stamp(Math.max(end, w.s + 0.15))},Cap,,0,0,0,,${pos}${POP}${kw(w)}`);
      });
    } else if (c.animation === "karaoke") {
      cue.words.forEach((w, i) => {
        const from = i === 0 ? cue.start : w.s, to = i + 1 < cue.words.length ? cue.words[i + 1].s : cue.end;
        const body = cue.words.map((x, j) => kw(x, j === i)).join(" ");
        lines.push(`Dialogue: 0,${stamp(from)},${stamp(to)},Cap,,0,0,0,,${pos}${i === 0 ? POP : ""}${body}`);
      });
    } else {
      const body = cue.words.map(w => kw(w)).join(" ");
      lines.push(`Dialogue: 0,${stamp(cue.start)},${stamp(cue.end)},Cap,,0,0,0,,${pos}${c.animation === "pop" ? POP : ""}${body}`);
    }
  }
  // Chat in a column on the left, under the hook and captions (layer 0, drawn first). Its windows are in source
  // seconds; the timeline counts from the trim's start.
  const t0 = edit.trim.start;
  for (const w of chatWindows(messages, edit)) {
    if (at(w.end - t0) - at(w.start - t0) < 0.05) continue;
    const body = w.lines.map(l => "{\\c" + assColor(l.color) + "}" + esc(l.name) + "{\\c&H00FFFFFF&}: " + esc(l.text)).join("\\N");
    lines.push("Dialogue: 0," + stamp(w.start - t0) + "," + stamp(w.end - t0) + ",Chat,,0,0,0,,{\\an1\\pos(40," + Math.round(edit.chat.y * H) + ")\\q2}" + body);
  }
  // The hook's times are already in the finished clip.
  if (showsHook(edit)) lines.push(`Dialogue: 1,${clock(0)},${clock(Math.min(len, edit.hook.seconds))},Hook,,${hp.margin},${hp.margin},0,,{\\an8\\pos(${hp.x},${hp.y})}${POP}${esc(edit.hook.text).replace(/\n/g, "\\N")}`);
  return lines.join("\n") + "\n";
}

const hex6 = c => "0x" + c.replace("#", "");
const fmt = n => String(Math.round(n * 1000) / 1000);

// The ffmpeg -filter_complex graph for an edit. `subtitles` is the ASS file name relative to ffmpeg's working
// directory (absolute Windows paths break filter syntax), or null when there is nothing to draw. `background` says
// whether input 1 is a split-screen background video; split screen without one falls back to the blurred fill.
// `audio`: { source, background } (which inputs have sound); the background video's sound is mixed in at
// frame.split.volume when it has some and the volume is above 0, ending with the clip. `tl` (see timeline): jump cuts
// are taken out of the picture and the stream's sound (audio.source must say whether it has sound), and punch-ins
// zoom the whole picture (not the captions).
// `emoji`: the input number of the colour emoji layer (see emoji.mjs), laid over the subtitles, or null.
export function filterGraph(edit, { width, height }, subtitles, { background = false, audio = null, tl = plain(edit), emoji = null } = {}) {
  const split = edit.frame.mode === "split" && background;
  // Split screen without a background, or a facecam layout without a webcam box, falls back to the blurred fill.
  const noCam = (edit.frame.mode === "cam" || edit.frame.mode === "pip") && !edit.frame.facecam?.box;
  const frame = (edit.frame.mode === "split" && !background) || noCam ? { ...edit.frame, mode: "blur" } : edit.frame;
  const { w, h, x, y, src: cut } = layout(frame, width, height), l = edit.look, { W, H } = canvas(edit.frame);
  // Brightness scales luma above video black (16), like the preview's CSS brightness(), through a lookup table:
  // colorchannelmixer did the same per pixel in floating point and made renders about four times slower.
  const look = [l.brightness !== 1 && `lutyuv=y=clip(16+(val-16)*${fmt(l.brightness)}\\,0\\,255)`, (l.contrast !== 1 || l.saturation !== 1) && `eq=contrast=${fmt(l.contrast)}:saturation=${fmt(l.saturation)}`].filter(Boolean).join(",");
  // Jump cuts drop the frames (and sound) inside each cut and close up the gaps; at a steady 30 fps first, so frame
  // numbers are times. Then phone mode cuts the phone picture out of the stream.
  const gone = tl.cuts.length ? tl.cuts.map(([a, b]) => `between(t,${fmt(a)},${fmt(b)})`).join("+") : "";
  const src = "[0:v]" + (gone ? `fps=30,select='not(${gone})',setpts=N/30/TB,` : "") + (frame.mode === "phone" ? `crop=${cut.w}:${cut.h}:${cut.x}:${cut.y},` : "") + (look ? look + "," : "");
  const parts = [];
  if (split) {
    // The stream scaled to cover its part and cut to it; the background covering the rest; stacked in the chosen
    // order, with a divider line on the seam if there is one.
    const a = splitAreas(edit.frame), divider = edit.frame.split?.divider;
    parts.push(src + `scale=${w}:${h},crop=${W}:${a.stream.h}:${-x}:${-y},setsar=1[st]`,
      `[1:v]scale=${W}:${a.background.h}:force_original_aspect_ratio=increase,crop=${W}:${a.background.h},fps=30,setsar=1[bk]`,
      (a.stream.y === 0 ? "[st][bk]" : "[bk][st]") + `vstack=inputs=2:shortest=1` + (divider ? `,drawbox=x=0:y=${a.seam - 3}:w=${W}:h=6:color=${hex6(divider)}:t=fill` : "") + `[v0]`);
  } else if (frame.mode === "cam" || frame.mode === "pip") {
    // The webcam cut out of the stream once, and the stream itself as the game.
    const fp = facecamPlacement(frame, width, height), divider = frame.split?.divider;
    const camCut = `[c]crop=${fp.sw}:${fp.sh}:${fp.sx}:${fp.sy},scale=${fp.w}:${fp.h},setsar=1`;
    if (frame.mode === "cam") {
      const a = camAreas(frame);
      parts.push(src + "split[g][c]", `[g]scale=${w}:${h},crop=${W}:${a.game.h}:${-x}:${-y},setsar=1[game]`, camCut + "[cam]",
        (a.cam.y === 0 ? "[cam][game]" : "[game][cam]") + "vstack=inputs=2" + (divider ? `,drawbox=x=0:y=${a.seam - 3}:w=${W}:h=6:color=${hex6(divider)}:t=fill` : "") + "[v0]");
    } else if (frame.facecam?.shape === "circle") {
      // A round webcam in a white ring: the cut is given a soft-edged circular alpha from a one-frame mask (alphamerge
      // repeats it), over a white disc RING pixels wider.
      const r = fp.w / 2, D = fp.w + 2 * RING, R = D / 2;
      const disc = (size, rad) => `geq=lum='255*clip(${fmt(rad)}-hypot(X+0.5-${fmt(size / 2)}\\,Y+0.5-${fmt(size / 2)})+0.5\\,0\\,1)'`;
      parts.push(src + "split[g][c]", `[g]scale=${w}:${h},crop=${W}:${H}:${-x}:${-y},setsar=1[game]`,
        `color=c=black:s=${fp.w}x${fp.w}:r=30:d=0.04,format=gray,${disc(fp.w, r)}[mask]`, camCut + `,format=yuva420p[cc]`, `[cc][mask]alphamerge[cam]`,
        `color=c=white:s=${D}x${D}:r=30:d=0.04,format=yuva420p,split[ring0][ringa]`, `[ringa]format=gray,${disc(D, R)}[ringm]`, `[ring0][ringm]alphamerge[ring]`,
        `[game][ring]overlay=${fp.x - RING}:${fp.y - RING}[gr]`, `[gr][cam]overlay=${fp.x}:${fp.y}[v0]`);
    } else {
      // A white border around the corner box.
      parts.push(src + "split[g][c]", `[g]scale=${w}:${h},crop=${W}:${H}:${-x}:${-y},setsar=1[game]`, camCut + `,pad=${fp.w + 8}:${fp.h + 8}:4:4:color=white[cam]`,
        `[game][cam]overlay=${fp.x - 4}:${fp.y - 4}[v0]`);
    }
  } else if (frame.mode === "blur") {
    parts.push(src + "split[a][b]", `[a]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},scale=${even(W / 4)}:${even(H / 4)},boxblur=8:2,eq=brightness=-0.12,scale=${W}:${H}[bg]`, `[b]scale=${w}:${h}[fg]`, `[bg][fg]overlay=${x}:${y}[v0]`);
  } else {
    parts.push(`color=c=black:s=${W}x${H}:r=30[bg]`, src + `scale=${w}:${h}[fg]`, `[bg][fg]overlay=${x}:${y}:shortest=1[v0]`);
  }
  let last = "v0";
  if (tl.punches.length) {
    // The same curve as zoomAt, per output frame (on/30 seconds), zooming on the middle of the picture.
    const T = "(on/30)", r = PUNCH;
    const z = tl.punches.map(p => `clip((${T}-${fmt(p)})/${r.rise},0,1)*clip((${fmt(p + r.rise + r.hold + r.fall)}-${T})/${r.fall},0,1)`).join("+");
    parts.push(`[v0]fps=30,zoompan=z='1+${r.zoom}*min(1,${z})':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s=${W}x${H}:fps=30[vz]`);
    last = "vz";
  }
  if (subtitles) { parts.push(`[${last}]subtitles=${subtitles}[v1]`); last = "v1"; }
  if (subtitles && emoji != null) { parts.push(`[${last}][${emoji}:v]overlay=0:0:eof_action=pass[ve]`); last = "ve"; }
  if (edit.progress.on) {
    const len = fmt(tl.length);
    parts.push(`color=c=${hex6(edit.progress.color)}:s=${W}x10:r=30[bar]`, `[${last}][bar]overlay=x='-w+w*t/${len}':y=main_h-10:eval=frame:shortest=1[v2]`);
    last = "v2";
  }
  parts.push(`[${last}]format=yuv420p,setsar=1[vout]`);
  const volume = edit.frame.split?.volume ?? 0, len = fmt(tl.length);
  // The stream's sound with the jump cuts taken out, like the picture.
  const cutSound = gone && audio?.source ? `aselect='not(${gone})',asetpts=N/SR/TB,` : "";
  if (split && audio?.background && volume > 0) {
    const bg = `[1:a]volume=${fmt(volume)},aresample=48000`;
    parts.push(audio.source ? `[0:a]${cutSound}aresample=48000[sa];${bg}[ba];[sa][ba]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]`
      : `${bg},atrim=duration=${len},asetpts=PTS-STARTPTS[aout]`);
  } else if (cutSound) parts.push(`[0:a]${cutSound}aresample=48000[aout]`);
  return parts.join(";");
}

export function needsSubtitles(edit, words, messages = []) { return showsHook(edit) || (edit.captions.on && (words?.length ?? 0) > 0) || (!!edit.chat?.on && (messages?.length ?? 0) > 0); }
