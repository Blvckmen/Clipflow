// Whole-stream recordings (capture mode "record" or "both"): the recorder keeps every segment, and when the stream
// ends they are joined into recording.mp4. The dashboard gets a heat strip and a small preview to scrub, and clips
// are cut from the full-quality file here, automatically (best moments) or at times the owner picked.
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { command } from "./process.mjs";

// Seconds of loudness/chat per heat-strip bar, so a long stream still fits in about `maxBars` bars.
export function bucketSignals(energy, chat = [], maxBars = 2000) {
  const length = energy.length, step = Math.max(1, Math.ceil(length / maxBars)), bars = Math.ceil(length / step);
  const e = [], c = [];
  for (let b = 0; b < bars; b++) {
    let loud = 0, talk = 0;
    for (let i = b * step; i < Math.min(length, (b + 1) * step); i++) { loud = Math.max(loud, energy[i] ?? 0); talk += chat[i] ?? 0; }
    e.push(loud); c.push(talk);
  }
  // Relative to a high percentile rather than the single loudest second, so one bang doesn't flatten the strip.
  const sorted = [...e].sort((a, b) => a - b), ref = sorted[Math.floor(sorted.length * 0.98)] || sorted.at(-1) || 1;
  return { step, energy: e.map(v => Math.round(Math.min(1, v / (ref || 1)) * 100) / 100), chat: c };
}

// The `count` best non-overlapping `duration`-second moments of a whole recording, as start seconds in order.
// Each second scores like pickWindow in highlights.mjs: loudness, plus chat `lag` seconds later when there is chat.
export function pickMoments({ energy, chat = [], duration, count, gap = 30, lag = 4, skip = 0 }) {
  const n = energy.length;
  if (n < duration || count < 1) return [];
  const peak = Math.max(0, ...energy), chatPeak = Math.max(0, ...chat), useChat = chatPeak > 0;
  const score = i => (peak ? (energy[i] ?? 0) / peak : 0) * (useChat ? 0.5 : 1) + (useChat ? ((chat[i + lag] ?? 0) / chatPeak) * 0.5 : 0);
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + score(i);
  // The first `skip` seconds (often a "starting soon" screen) are never chosen.
  const starts = [];
  for (let s = Math.min(skip, n - duration); s <= n - duration; s++) starts.push(s);
  starts.sort((a, b) => (prefix[b + duration] - prefix[b]) - (prefix[a + duration] - prefix[a]) || a - b);
  const chosen = [];
  for (const s of starts) {
    if (chosen.length >= count) break;
    if (chosen.every(c => Math.abs(c - s) >= duration + gap)) chosen.push(s);
  }
  return chosen.sort((a, b) => a - b);
}

// Segment files in recording order: from ffmpeg's segment list, or by name when the list is missing (a crash
// before ffmpeg wrote it).
export async function segmentFiles(dir) {
  const listed = (await readFile(join(dir, "list.csv"), "utf8").catch(() => "")).split(/\r?\n/).map(row => row.split(",")[0]).filter(f => /^seg\d{6}\.m2t$/.test(f));
  const present = new Set((await readdir(dir).catch(() => [])).filter(f => /^seg\d{6}\.m2t$/.test(f)));
  const ordered = listed.filter(f => present.has(f));
  for (const f of [...present].sort()) if (!ordered.includes(f)) ordered.push(f);
  return ordered;
}

// Joins the kept segments into one MP4 (no re-encode) and removes them. Returns false when there was nothing.
export async function joinSegments(dir, out, signal) {
  const files = await segmentFiles(dir);
  if (!files.length) return false;
  await writeFile(join(dir, "concat.txt"), files.map(f => "file '" + f + "'").join("\n"));
  await command("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", "concat.txt", "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy", "-bsf:a", "aac_adtstoasc", "-movflags", "+faststart", out],
    { cwd: dir, signal, timeout: 60 * 60_000 }).done;
  await rm(dir, { recursive: true, force: true });
  return true;
}

// A small 360p copy for scrubbing in the dashboard (about 200 MB an hour). Uses two threads so it doesn't starve
// live clipping running alongside it.
export async function encodePreview(file, out, seconds, signal) {
  await command("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", file, "-vf", "scale=-2:360", "-r", "30",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-maxrate", "450k", "-bufsize", "900k", "-g", "60", "-threads", "2",
    "-c:a", "aac", "-b:a", "64k", "-ac", "1", "-movflags", "+faststart", out], { signal, timeout: Math.max(30 * 60_000, Math.ceil(seconds) * 3000) }).done;
}

// Copies [from, to] seconds of a recording into an MPEG-TS window for processWindow (no re-encode).
export async function extractRange(file, from, to, out, signal) {
  await command("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(Math.max(0, from)), "-i", file, "-t", String(to - Math.max(0, from)), "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy", "-f", "mpegts", out],
    { signal, timeout: 120_000 }).done;
}

// R2 multipart parts must all be the same size except the last; 48 MiB stays under Workers' request body limit.
export const PART_BYTES = 48 * 1024 * 1024;
export function parts(size, partBytes = PART_BYTES) {
  const out = [];
  for (let offset = 0, number = 1; offset < size; offset += partBytes, number++) out.push({ number, offset, length: Math.min(partBytes, size - offset) });
  return out;
}
