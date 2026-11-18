// The clip edit model, shared by the dashboard editor (live canvas preview) and the worker (ffmpeg render), so
// what the editor shows is laid out by the same numbers the render uses. Pure functions only: no Node or DOM APIs.
//
// An edit describes how to turn a clip's *source* (the captured moment plus a few seconds either side, unframed)
// into the published 720x1280 clip. Times are seconds from the start of the source.
//   { v, trim:{start,end}, frame:{mode,zoom,x,y,background}, look:{brightness,contrast,saturation},
//     captions:{on,preset,font,size,color,highlight,outline,outlineColor,box,boxColor,uppercase,animation,words,y,mask},
//     hook:{text,seconds,color,bg}, progress:{on,color}, words?:[[start,end,text],...] }
// A *style* is the reusable part of an edit (everything except trim, hook text and words; it includes how long the
// hook stays up). Hook seconds at or past the clip's length keep the hook up for the whole clip. Each streamer can have
// its own style, so every new clip from that streamer comes out with that streamer's look.

export const W = 720, H = 1280;
export const FONTS = ["Arial", "Impact", "Verdana", "Trebuchet MS", "Georgia", "Comic Sans MS", "DejaVu Sans"];
// "split": the stream fills part of the frame and a background (a looping video or a still image from the workspace's
// library) the rest. frame.split: share (the stream's part of the height, 0.3-0.8), top ("stream" or "background":
// which is on top), divider (a #rrggbb line on the seam, or null) and volume (the background video's sound, 0-1). frame.background is a library video's id, "clip:<id>" for another gallery clip, or null to let the worker
// pick a library video for the clip (the same one each time it renders that clip). Only videos at least as long as
// the clip are used; longer ones are cut to its length.
export const FRAMINGS = ["blur", "crop", "fit", "split"];
export const ANIMATIONS = ["none", "pop", "karaoke", "word"];
export const MIN_CLIP = 5, MAX_CLIP = 90;
// How long a hook title stays up unless the look says otherwise; up to the whole clip.
export const DEFAULT_HOOK_SECONDS = 5;
export const DEFAULT_SPLIT = { share: 0.5, top: "stream", divider: null, volume: 0 };
export const SPLIT_TOPS = ["stream", "background"];

// Caption looks. Picking a preset copies its values; every value can then be changed on its own.
export const PRESETS = {
  clean: { label: "Clean", font: "Arial", size: 54, color: "#ffffff", highlight: "#ffffff", outline: 4, outlineColor: "#000000", box: false, boxColor: "#000000", uppercase: false, animation: "none", words: 4 },
  bold: { label: "Bold pop", font: "Impact", size: 74, color: "#ffffff", highlight: "#ffe14d", outline: 6, outlineColor: "#000000", box: false, boxColor: "#000000", uppercase: true, animation: "pop", words: 3 },
  karaoke: { label: "Karaoke", font: "Arial", size: 60, color: "#ffffff", highlight: "#bcfa76", outline: 5, outlineColor: "#000000", box: false, boxColor: "#000000", uppercase: false, animation: "karaoke", words: 4 },
  boxed: { label: "Boxed", font: "Verdana", size: 46, color: "#111111", highlight: "#e0245e", outline: 0, outlineColor: "#000000", box: true, boxColor: "#ffffff", uppercase: false, animation: "karaoke", words: 5 },
  neon: { label: "Neon", font: "Trebuchet MS", size: 62, color: "#7df9ff", highlight: "#ff4fd8", outline: 3, outlineColor: "#1a0033", box: false, boxColor: "#000000", uppercase: true, animation: "karaoke", words: 3 },
  single: { label: "One word", font: "Impact", size: 96, color: "#ffffff", highlight: "#ffffff", outline: 7, outlineColor: "#000000", box: false, boxColor: "#000000", uppercase: true, animation: "word", words: 1 },
};

export function defaultStyle({ framing = "blur", captions = true } = {}) {
  const preset = { ...PRESETS.bold };
  delete preset.label;
  return {
    frame: { mode: FRAMINGS.includes(framing) ? framing : "blur", zoom: 1, x: 0, y: 0, background: null, split: { ...DEFAULT_SPLIT } },
    look: { brightness: 1, contrast: 1, saturation: 1 },
    // Split screen puts captions on the seam between the two videos.
    captions: { on: !!captions, preset: "bold", ...preset, y: framing === "split" ? 0.5 : 0.72, mask: false },
    hook: { color: "#111111", bg: "#ffffff", seconds: DEFAULT_HOOK_SECONDS },
    progress: { on: false, color: "#bcfa76" },
  };
}

class EditError extends Error {}
const fail = message => { throw new EditError(message); };
const num = (v, min, max, name) => { if (typeof v !== "number" || !Number.isFinite(v)) fail(name + " must be a number"); return Math.min(max, Math.max(min, v)); };
const int = (v, min, max, name) => Math.round(num(v, min, max, name));
const bool = (v, name) => { if (typeof v !== "boolean") fail(name + " must be true or false"); return v; };
const color = (v, name) => { if (typeof v !== "string" || !/^#[0-9a-f]{6}$/i.test(v)) fail(name + " must be a #rrggbb colour"); return v.toLowerCase(); };
const pick = (v, list, name) => { if (!list.includes(v)) fail(name + " is not a supported value"); return v; };
const text = (v, max, name) => { if (typeof v !== "string") fail(name + " must be text"); return v.replace(/[\r\n]+/g, " ").replace(/[{}\\]/g, "").slice(0, max); };
const obj = (v, name) => { if (!v || typeof v !== "object" || Array.isArray(v)) fail(name + " is missing"); return v; };
// A background video: a library video's id, or "clip:<id>" for another clip from the gallery.
const ref = (v, name) => { if (v === null || v === undefined) return null; if (typeof v !== "string" || !/^(clip:)?[0-9a-f-]{36}$/i.test(v)) fail(name + " is not valid"); return v.toLowerCase(); };

// Validates a style from an untrusted client (or an older saved one), filling any missing part from the defaults.
export function normalizeStyle(input, base = defaultStyle()) {
  const s = obj(input, "Style");
  const f = { ...base.frame, ...(s.frame ?? {}) }, sp = { ...DEFAULT_SPLIT, ...(base.frame.split ?? {}), ...(s.frame?.split ?? {}) }, l = { ...base.look, ...(s.look ?? {}) }, c = { ...base.captions, ...(s.captions ?? {}) };
  const h = { ...base.hook, ...(s.hook ?? {}) }, p = { ...base.progress, ...(s.progress ?? {}) };
  return {
    frame: { mode: pick(f.mode, FRAMINGS, "Framing"), zoom: num(f.zoom, 1, 3, "Zoom"), x: num(f.x, -1, 1, "Horizontal position"), y: num(f.y, -1, 1, "Vertical position"), background: ref(f.background, "Background video"),
      split: { share: num(sp.share, 0.3, 0.8, "Stream share"), top: pick(sp.top, SPLIT_TOPS, "Split order"), divider: sp.divider === null ? null : color(sp.divider, "Divider colour"), volume: num(sp.volume, 0, 1, "Background volume") } },
    look: { brightness: num(l.brightness, 0.5, 1.5, "Brightness"), contrast: num(l.contrast, 0.5, 1.5, "Contrast"), saturation: num(l.saturation, 0, 2, "Saturation") },
    captions: {
      on: bool(c.on, "Captions"), preset: typeof c.preset === "string" && PRESETS[c.preset] ? c.preset : "custom",
      font: pick(c.font, FONTS, "Font"), size: int(c.size, 24, 140, "Caption size"), color: color(c.color, "Caption colour"), highlight: color(c.highlight, "Highlight colour"),
      outline: int(c.outline, 0, 12, "Outline"), outlineColor: color(c.outlineColor, "Outline colour"), box: bool(c.box, "Caption box"), boxColor: color(c.boxColor, "Box colour"),
      uppercase: bool(c.uppercase, "Uppercase"), animation: pick(c.animation, ANIMATIONS, "Animation"), words: int(c.words, 1, 8, "Words per line"), y: num(c.y, 0.08, 0.95, "Caption position"), mask: bool(c.mask, "Profanity filter"),
    },
    hook: { color: color(h.color, "Hook text colour"), bg: color(h.bg, "Hook background"), seconds: num(h.seconds ?? DEFAULT_HOOK_SECONDS, 1, MAX_CLIP, "Hook length") },
    progress: { on: bool(p.on, "Progress bar"), color: color(p.color, "Progress bar colour") },
  };
}

export function styleOf(edit) {
  const { frame, look, captions, hook, progress } = edit;
  return { frame, look, captions, hook: { color: hook.color, bg: hook.bg, seconds: hook.seconds }, progress };
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
  const out = { v: 1, trim: { start: round(start), end: round(end) }, ...style, hook: { ...style.hook, text: text(hook.text ?? "", 90, "Hook text").trim(), seconds: num(hook.seconds ?? style.hook.seconds, 1, MAX_CLIP, "Hook length") } };
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
  const sp = { ...DEFAULT_SPLIT, ...(frame?.split ?? {}) };
  const streamH = even(H * Math.min(0.8, Math.max(0.3, sp.share))), bgH = H - streamH, streamTop = sp.top !== "background";
  return { stream: { y: streamTop ? 0 : bgH, h: streamH }, background: { y: streamTop ? streamH : 0, h: bgH }, seam: streamTop ? streamH : bgH };
}
export function layout(frame, width, height) {
  const sw = width > 0 ? width : 1280, sh = height > 0 ? height : 720;
  const areas = frame.mode === "split" ? splitAreas(frame) : null;
  const AW = W, AH = areas ? areas.stream.h : H;
  const base = frame.mode === "crop" || frame.mode === "split" ? Math.max(AW / sw, AH / sh) : Math.min(AW / sw, AH / sh);
  const w = even(sw * base * frame.zoom), h = even(sh * base * frame.zoom);
  return { w, h, x: Math.round((AW - w) / 2 + frame.x * Math.abs(AW - w) / 2), y: Math.round((AH - h) / 2 + frame.y * Math.abs(AH - h) / 2), area: { w: AW, h: AH, y: areas ? areas.stream.y : 0 } };
}

const SWEAR = /^(fuck|shit|bitch|cunt|dick|puss|asshole|bastard|cock|slut|whore|fag|nigg|motherf)/i;
export function maskWord(word) {
  const bare = word.replace(/[^\p{L}\p{N}']/gu, "");
  if (!SWEAR.test(bare)) return word;
  let seen = false;
  return word.replace(/[\p{L}\p{N}]/gu, ch => { if (!seen) { seen = true; return ch; } return "*"; });
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
    cur.push({ s, e, t });
    if (/[.?!]$/.test(t)) flush();
  }
  flush();
  return out.map((ws, i) => {
    const next = out[i + 1];
    let e = Math.max(ws.at(-1).e, ws[0].s + 0.4);
    if (next) e = Math.min(e, next[0].s);
    return { start: ws[0].s, end: e, words: ws };
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

// ---- ASS subtitles for the render ----
// ASS colours are &HAABBGGRR with AA=00 opaque.
export function assColor(hex, alpha = 0) {
  const h = hex.replace("#", "");
  return "&H" + alpha.toString(16).padStart(2, "0").toUpperCase() + (h.slice(4, 6) + h.slice(2, 4) + h.slice(0, 2)).toUpperCase();
}
const stamp = t => { const cs = Math.max(0, Math.round(t * 100)); return Math.floor(cs / 360000) + ":" + String(Math.floor(cs / 6000) % 60).padStart(2, "0") + ":" + String(Math.floor(cs / 100) % 60).padStart(2, "0") + "." + String(cs % 100).padStart(2, "0"); };
const esc = t => t.replace(/[{}\\]/g, "");
const POP = "{\\fscx82\\fscy82\\t(0,110,\\fscx100\\fscy100)}";

export function buildAss(edit, words) {
  const c = edit.captions, len = edit.trim.end - edit.trim.start, y = Math.round(c.y * H);
  const boxStyle = c.box ? { border: 3, outline: Math.max(8, Math.round(c.size * 0.22)), outlineColor: assColor(c.boxColor) } : { border: 1, outline: c.outline, outlineColor: assColor(c.outlineColor) };
  const lines = [
    "[Script Info]", "ScriptType: v4.00+", "PlayResX: " + W, "PlayResY: " + H, "WrapStyle: 0", "ScaledBorderAndShadow: yes", "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Cap,${c.font},${c.size},${assColor(c.color)},${assColor(c.highlight)},${boxStyle.outlineColor},${assColor("#000000", 0x80)},-1,0,0,0,100,100,0,0,${boxStyle.border},${boxStyle.outline},0,5,40,40,0,1`,
    `Style: Hook,${c.font},52,${assColor(edit.hook.color)},${assColor(edit.hook.color)},${assColor(edit.hook.bg)},${assColor("#000000", 0x80)},-1,0,0,0,100,100,0,0,3,14,0,8,60,60,0,1`,
    "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const at = "{\\an5\\pos(" + W / 2 + "," + y + ")}";
  const hl = "{\\c" + assColor(c.highlight) + "}", base = "{\\c" + assColor(c.color) + "}";
  if (c.on) for (const cue of cues(words, edit)) {
    if (c.animation === "word") {
      cue.words.forEach((w, i) => {
        const end = i + 1 < cue.words.length ? cue.words[i + 1].s : cue.end;
        lines.push(`Dialogue: 0,${stamp(w.s)},${stamp(Math.max(end, w.s + 0.15))},Cap,,0,0,0,,${at}${POP}${esc(w.t)}`);
      });
    } else if (c.animation === "karaoke") {
      cue.words.forEach((w, i) => {
        const from = i === 0 ? cue.start : w.s, to = i + 1 < cue.words.length ? cue.words[i + 1].s : cue.end;
        const body = cue.words.map((x, j) => j === i ? hl + esc(x.t) + base : esc(x.t)).join(" ");
        lines.push(`Dialogue: 0,${stamp(from)},${stamp(to)},Cap,,0,0,0,,${at}${i === 0 ? POP : ""}${body}`);
      });
    } else {
      const body = cue.words.map(w => esc(w.t)).join(" ");
      lines.push(`Dialogue: 0,${stamp(cue.start)},${stamp(cue.end)},Cap,,0,0,0,,${at}${c.animation === "pop" ? POP : ""}${body}`);
    }
  }
  if (edit.hook.text) lines.push(`Dialogue: 1,${stamp(0)},${stamp(Math.min(len, edit.hook.seconds))},Hook,,0,0,0,,{\\an8\\pos(${W / 2},150)}${POP}${esc(edit.hook.text)}`);
  return lines.join("\n") + "\n";
}

const hex6 = c => "0x" + c.replace("#", "");
const fmt = n => String(Math.round(n * 1000) / 1000);

// The ffmpeg -filter_complex graph for an edit. `subtitles` is the ASS file name relative to ffmpeg's working
// directory (absolute Windows paths break filter syntax), or null when there is nothing to draw. `background` says
// whether input 1 is a split-screen background video; split screen without one falls back to the blurred fill.
// `audio`: { source, background } (which inputs have sound); the background video's sound is mixed in at
// frame.split.volume when it has some and the volume is above 0, ending with the clip.
export function filterGraph(edit, { width, height }, subtitles, { background = false, audio = null } = {}) {
  const split = edit.frame.mode === "split" && background;
  const frame = edit.frame.mode === "split" && !background ? { ...edit.frame, mode: "blur" } : edit.frame;
  const { w, h, x, y } = layout(frame, width, height), l = edit.look;
  // Brightness scales luma above video black (16), like the preview's CSS brightness(), through a lookup table:
  // colorchannelmixer did the same per pixel in floating point and made renders about four times slower.
  const look = [l.brightness !== 1 && `lutyuv=y=clip(16+(val-16)*${fmt(l.brightness)}\\,0\\,255)`, (l.contrast !== 1 || l.saturation !== 1) && `eq=contrast=${fmt(l.contrast)}:saturation=${fmt(l.saturation)}`].filter(Boolean).join(",");
  const src = "[0:v]" + (look ? look + "," : "");
  const parts = [];
  if (split) {
    // The stream scaled to cover its part and cut to it; the background covering the rest; stacked in the chosen
    // order, with a divider line on the seam if there is one.
    const a = splitAreas(edit.frame), divider = edit.frame.split?.divider;
    parts.push(src + `scale=${w}:${h},crop=${W}:${a.stream.h}:${-x}:${-y},setsar=1[st]`,
      `[1:v]scale=${W}:${a.background.h}:force_original_aspect_ratio=increase,crop=${W}:${a.background.h},fps=30,setsar=1[bk]`,
      (a.stream.y === 0 ? "[st][bk]" : "[bk][st]") + `vstack=inputs=2:shortest=1` + (divider ? `,drawbox=x=0:y=${a.seam - 3}:w=${W}:h=6:color=${hex6(divider)}:t=fill` : "") + `[v0]`);
  } else if (frame.mode === "blur") {
    parts.push(src + "split[a][b]", `[a]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},scale=180:320,boxblur=8:2,eq=brightness=-0.12,scale=${W}:${H}[bg]`, `[b]scale=${w}:${h}[fg]`, `[bg][fg]overlay=${x}:${y}[v0]`);
  } else {
    parts.push(`color=c=black:s=${W}x${H}:r=30[bg]`, src + `scale=${w}:${h}[fg]`, `[bg][fg]overlay=${x}:${y}:shortest=1[v0]`);
  }
  let last = "v0";
  if (subtitles) { parts.push(`[${last}]subtitles=${subtitles}[v1]`); last = "v1"; }
  if (edit.progress.on) {
    const len = fmt(edit.trim.end - edit.trim.start);
    parts.push(`color=c=${hex6(edit.progress.color)}:s=${W}x10:r=30[bar]`, `[${last}][bar]overlay=x='-w+w*t/${len}':y=main_h-10:eval=frame:shortest=1[v2]`);
    last = "v2";
  }
  parts.push(`[${last}]format=yuv420p,setsar=1[vout]`);
  const volume = edit.frame.split?.volume ?? 0, len = fmt(edit.trim.end - edit.trim.start);
  if (split && audio?.background && volume > 0) {
    const bg = `[1:a]volume=${fmt(volume)},aresample=48000`;
    parts.push(audio.source ? `[0:a]aresample=48000[sa];${bg}[ba];[sa][ba]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]`
      : `${bg},atrim=duration=${len},asetpts=PTS-STARTPTS[aout]`);
  }
  return parts.join(";");
}

export function needsSubtitles(edit, words) { return !!edit.hook.text || (edit.captions.on && (words?.length ?? 0) > 0); }
