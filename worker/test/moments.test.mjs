import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { scanRanges, suggestMoments } from "../recordings.mjs";
import { screenText, screenTextAvailable } from "../screentext.mjs";
const run = promisify(execFile);
const python = process.env.PYTHON || "py";

test("suggested moments: best first, apart, with what stood out", () => {
  const energy = Array.from({ length: 600 }, (_, i) => (i >= 100 && i < 130 ? 1 : i >= 400 && i < 430 ? 0.7 : 0.1));
  const chat = Array.from({ length: 600 }, (_, i) => (i >= 404 && i < 434 ? 20 : 1));
  const m = suggestMoments({ energy, chat, duration: 30, count: 5 });
  assert.equal(m.length, 5);
  assert.deepEqual([m[0].start, m[0].end, m[0].score], [400, 430, 1], "loud and busy beats only loud");
  assert.ok(m[0].why.some(w => /^Chat \d+× busier$/.test(w)) && m[0].why.includes("Loud"));
  assert.equal(m[1].start, 100);
  assert.ok(m[1].score < 1 && m[1].why.includes("Loud"));
  assert.ok(m.every((x, i) => m.every((y, j) => i === j || Math.abs(x.start - y.start) >= 45)), "never overlapping");
  assert.ok(m.every(x => x.why.length >= 1 && x.why.length <= 4));
  assert.deepEqual(suggestMoments({ energy: [1, 1], duration: 30 }), [], "shorter than a clip");
});

test("a game banner on screen makes its own moment, mostly before the banner", () => {
  const energy = Array.from({ length: 600 }, (_, i) => (i >= 100 && i < 130 ? 1 : 0.1));
  const m = suggestMoments({ energy, duration: 30, count: 3, events: [{ t: 500, text: "WASTED" }] });
  assert.equal(m[0].start, 482, "18s before the banner, 12s after");
  assert.deepEqual(m[0].why, ["WASTED on screen"]);
  assert.equal(m[1].start, 100);
});

test("the screen is read only around the strongest windows, merged", () => {
  const energy = Array.from({ length: 1000 }, (_, i) => (i >= 100 && i < 130 ? 1 : i >= 150 && i < 180 ? 0.9 : i >= 800 && i < 830 ? 0.8 : 0));
  const r = scanRanges({ energy, duration: 30, count: 3, pad: 15 });
  assert.ok(r.length >= 2 && r.length <= 3);
  assert.ok(r.every(([a, b]) => a >= 0 && b <= 1000 && b > a));
  assert.ok(r.some(([a, b]) => a <= 100 && b >= 180), "close windows merge");
  assert.ok(r.some(([a, b]) => a <= 800 && b >= 830));
  assert.ok(r.reduce((t, [a, b]) => t + b - a, 0) < 400, "far less than the whole recording");
});

test("RapidOCR finds a big WASTED banner in a range and ignores small HUD text", async t => {
  if (!await screenTextAvailable(python)) return t.skip("RapidOCR not installed");
  try { await run("ffmpeg", ["-version"]); } catch { return t.skip("ffmpeg not installed"); }
  const dir = await mkdtemp(join(tmpdir(), "screen-"));
  try {
    const font = process.platform === "win32" ? "C\\:/Windows/Fonts/arialbd.ttf" : "DejaVuSans-Bold";
    const file = join(dir, "game.mp4");
    await run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=0x223344:size=1280x720:rate=30:duration=30", "-vf",
      `drawtext=fontfile='${font}':text='WASTED':fontsize=120:fontcolor=red:x=(w-tw)/2:y=(h-th)/2:enable='between(t,20,23)',drawtext=fontfile='${font}':text='VICTORY':fontsize=18:fontcolor=white:x=20:y=20`,
      "-c:v", "libx264", "-pix_fmt", "yuv420p", file]);
    const events = await screenText(file, { python, ranges: [[0, 6], [16, 26]], every: 2, scratch: join(dir, "scan") });
    assert.deepEqual(events, [{ t: 20, text: "WASTED" }], "the small VICTORY in the corner is HUD, not a banner");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
