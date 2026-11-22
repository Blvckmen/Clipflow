// Colour emoji in the render. libass (ffmpeg's subtitle renderer) draws emoji from the colour font's plain outline, in
// the text colour. So libass still lays every line out, emoji included, but draws the emoji invisibly, and a
// transparent layer with the real colour emoji goes over the picture after the subtitles:
//  1. emoji.py sheet: which emoji the system's colour font can draw, as tight images.
//  2. A probe render of the same subtitles, one frame per distinct line layout: all text invisible except each emoji,
//     filled in its own colour, so its box on screen can be read from the frame (libass's own layout, wrapping and
//     sizes, nothing guessed).
//  3. emoji.py compose: a W x H layer per stretch of time where the emoji on screen don't change, joined by an
//     ffconcat list that the render overlays.
// Any failure (no Python packages, no font) leaves the subtitles as they were: plain emoji instead of none.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { command } from "./process.mjs";

// One emoji: a flag, a keycap, or a pictograph shown as emoji (by default or with VS16), with a skin tone and joined
// (ZWJ) parts. Plain text symbols (©, ™, ↔ without VS16) stay text.
export const EMOJI = /\p{RI}\p{RI}|[#*0-9]️?⃣|(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}️)\p{EMod}?️?(?:‍\p{Extended_Pictographic}️?\p{EMod}?️?)*/gu;
const MAX_PER_LINE = 254, MAX_FRAMES = 3000;

const parts = text => text.split(/(\{[^}]*\})/); // odd entries are override blocks
const mapText = (text, fn) => parts(text).map((p, i) => i % 2 ? p : fn(p)).join("");
// A Dialogue line's ten fields; the last (text) may contain commas.
function dialogue(line) {
  if (!line.startsWith("Dialogue:")) return null;
  const f = line.slice(9).trim().split(",");
  return [...f.slice(0, 9), f.slice(9).join(",")];
}
const seconds = clock => { const [h, m, s] = clock.split(":"); return +h * 3600 + +m * 60 + +s; };
const clock = t => { const cs = Math.round(t * 100); return Math.floor(cs / 360000) + ":" + String(Math.floor(cs / 6000) % 60).padStart(2, "0") + ":" + String(Math.floor(cs / 100) % 60).padStart(2, "0") + "." + String(cs % 100).padStart(2, "0"); };

// Every distinct emoji in the subtitles' text, in order of first appearance.
export function emojiIn(ass) {
  const seen = new Set();
  for (const line of ass.split("\n")) { const d = dialogue(line); if (d) mapText(d[9], p => { for (const m of p.matchAll(EMOJI)) seen.add(m[0]); return p; }); }
  return [...seen];
}

// Style name -> BorderStyle (1 outline, 3 box).
function borders(ass) {
  const out = {};
  for (const line of ass.split("\n")) if (line.startsWith("Style:")) { const f = line.slice(6).split(","); out[f[0].trim()] = +f[15]; }
  return out;
}

// The subtitles with each colourable emoji drawn invisibly: no fill, and no outline either unless the style draws a
// box (BorderStyle 3), whose box is the outline. It still takes its place in the line.
export function hideEmoji(ass, colour) {
  const box = borders(ass);
  return ass.split("\n").map(line => {
    const d = dialogue(line);
    if (!d) return line;
    const [on, off] = box[d[3]] === 3 ? ["\\1a&HFF&", "\\1a&H00&"] : ["\\1a&HFF&\\3a&HFF&", "\\1a&H00&\\3a&H00&"];
    const text = mapText(d[9], p => p.replace(EMOJI, e => colour.has(e) ? `{${on}}${e}{${off}}` : e));
    return text === d[9] ? line : "Dialogue: " + [...d.slice(0, 9), text].join(",");
  }).join("\n");
}

// The line's layout, ignoring what doesn't move anything: colours (karaoke) and the pop-in (over before the probe looks).
const layoutKey = d => [d[3], d[5], d[6], d[7], d[9].replace(/\\1?c&H[0-9A-Fa-f]+&?/g, "").replace(/\\t\([^)]*\)/g, "").replace(/\\fsc[xy]82/g, "").replace(/\{\}/g, "")].join("|");

// The probe subtitles: layout k on screen from k+0.5s to k+1.5s (frame k+1 at 1 fps), every glyph invisible but the
// emoji, the j-th filled pure rgb(255, j+1, 0). `events`: the real lines with colour emoji, with their times and layout.
export function probe(ass, colour) {
  const lines = ass.split("\n"), head = [], layouts = [], index = new Map(), events = [], body = [];
  for (const line of lines) {
    const d = dialogue(line);
    if (!d) {
      if (line.startsWith("Dialogue:") || line.startsWith("YCbCr Matrix:") || !line.trim()) continue;
      head.push(line);
      // Without this libass shifts colours toward TV range and the probe colours wouldn't come back exact.
      if (line.trim() === "[Script Info]") head.push("YCbCr Matrix: None");
      continue;
    }
    const found = [];
    mapText(d[9], p => { for (const m of p.matchAll(EMOJI)) if (colour.has(m[0])) found.push(m[0]); return p; });
    if (!found.length) continue;
    if (found.length > MAX_PER_LINE) throw new Error("too many emoji in one line");
    const key = layoutKey(d);
    if (!index.has(key)) {
      const k = layouts.length;
      index.set(key, k);
      layouts.push(found);
      let j = 0;
      const text = "{\\1a&HFF&\\3a&HFF&\\4a&HFF&}" + mapText(d[9], p => p.replace(EMOJI, e => colour.has(e) ? `{\\1a&H00&\\1c&H00${(++j).toString(16).padStart(2, "0").toUpperCase()}FF&}${e}{\\1a&HFF&}` : e));
      body.push("Dialogue: " + [d[0], clock(k + 0.5), clock(k + 1.5), ...d.slice(3, 9), text].join(","));
    }
    events.push({ start: seconds(d[1]), end: seconds(d[2]), layout: index.get(key) });
  }
  return { ass: [...head, ...body].join("\n") + "\n", layouts, events };
}

// The box of each probe colour in one rgb24 frame: [{ x, y, w, h } | null] for colours 1..count. Only fully covered
// pixels match exactly; the box grows a pixel each side for the anti-aliased edge they leave out.
export function boxesIn(frame, width, height, count) {
  const min = new Array(count).fill(null).map(() => [Infinity, Infinity, -1, -1]);
  for (let y = 0, p = 0; y < height; y++) for (let x = 0; x < width; x++, p += 3) {
    if (frame[p] !== 255 || frame[p + 2] !== 0) continue;
    const j = frame[p + 1] - 1;
    if (j < 0 || j >= count) continue;
    const b = min[j];
    if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y;
  }
  return min.map(([x0, y0, x1, y1]) => x1 < 0 ? null : { x: Math.max(0, x0 - 1), y: Math.max(0, y0 - 1), w: Math.min(width, x1 + 2) - Math.max(0, x0 - 1), h: Math.min(height, y1 + 2) - Math.max(0, y0 - 1) });
}

// The overlay's frames: each stretch of time with the same emoji on screen, from 0. `boxes[k]`: layout k's emoji
// boxes, each { i (the sheet image), x, y, w, h }. Returns [{ duration, items }] with no gaps.
export function layerFrames(events, boxes) {
  const points = [...new Set([0, ...events.flatMap(e => [e.start, e.end])])].sort((a, b) => a - b), out = [];
  for (let n = 0; n + 1 < points.length; n++) {
    const a = points[n], b = points[n + 1];
    const items = events.filter(e => e.start <= a && e.end >= b).flatMap(e => boxes[e.layout] ?? []);
    const last = out.at(-1);
    if (last && JSON.stringify(last.items) === JSON.stringify(items)) last.duration += b - a;
    else out.push({ duration: b - a, items });
  }
  out.push({ duration: 1, items: [] });
  return out;
}

// The ffconcat list playing the layer's frames f0.png, f1.png... Each change comes half a frame (at 30 fps) early:
// the overlay only takes a layer frame from the video frame after its time, and the subtitles change on the frame at
// it. Durations come from rounded running times, so they don't drift.
export const LEAD = 1 / 60;
export function concatList(frames) {
  const lines = ["ffconcat version 1.0"];
  let at = 0, written = 0;
  frames.forEach((f, n) => {
    at += f.duration;
    const end = Math.max(written + 0.001, Math.round((at - LEAD) * 1000) / 1000);
    lines.push(`file 'f${n}.png'`, `duration ${(end - written).toFixed(3)}`);
    written = end;
  });
  return [...lines, `file 'f${frames.length - 1}.png'`].join("\n") + "\n";
}

const script = fileURLToPath(new URL("./emoji.py", import.meta.url));

// Makes the colour emoji layer for the subtitles `ass` (W x H) in `dir`, a folder of its own. Returns null when there
// are no colourable emoji, else { ass (the subtitles with those emoji invisible), list (the ffconcat file to overlay) }.
export async function colourEmoji(ass, dir, { width, height, python = process.env.PYTHON || "python", signal } = {}) {
  const emoji = emojiIn(ass);
  if (!emoji.length) return null;
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "sheet-job.json"), JSON.stringify({ emoji }), "utf8");
  await command(python, [script, "sheet", dir], { signal, timeout: 60_000 }).done;
  const ids = JSON.parse(await readFile(join(dir, "sheet.json"), "utf8")).colour;
  const colour = new Set(ids.map(i => emoji[i])), image = new Map(ids.map(i => [emoji[i], i]));
  if (!colour.size) return null;
  const test = probe(ass, colour);
  if (!test.layouts.length) return null;
  await writeFile(join(dir, "probe.ass"), test.ass, "utf8");
  // One frame per layout after a blank first one, read as they arrive (each is W x H x 3 bytes).
  const size = width * height * 3, boxes = [];
  let pending = [], have = 0, frame = 0;
  const run = command("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=black:s=${width}x${height}:r=1:d=${test.layouts.length + 1}`,
    "-vf", "format=rgb24,subtitles=probe.ass", "-frames:v", String(test.layouts.length + 1), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { signal, cwd: dir, stdout: "pipe", timeout: 120_000 });
  run.child.stdout.on("data", chunk => {
    pending.push(chunk); have += chunk.length;
    while (have >= size) {
      const all = Buffer.concat(pending), buf = all.subarray(0, size);
      pending = [all.subarray(size)]; have -= size;
      const k = frame++ - 1;
      if (k >= 0 && k < test.layouts.length) {
        const list = test.layouts[k];
        boxes[k] = boxesIn(buf, width, height, list.length).flatMap((b, j) => b ? [{ i: image.get(list[j]), ...b }] : []);
      }
    }
  });
  await run.done;
  const frames = layerFrames(test.events, boxes);
  if (frames.length > MAX_FRAMES) throw new Error("emoji change too often (" + frames.length + " layers)");
  await writeFile(join(dir, "compose-job.json"), JSON.stringify({ width, height, frames: frames.map(f => f.items) }), "utf8");
  await command(python, [script, "compose", dir], { signal, timeout: 300_000 }).done;
  await writeFile(join(dir, "layer.ffconcat"), concatList(frames), "utf8");
  return { ass: hideEmoji(ass, colour), list: join(dir, "layer.ffconcat") };
}
