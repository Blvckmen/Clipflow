// Pace: jump cuts (quiet pauses between words taken out) and punch-in zooms (on the loudest moments), worked out the
// same way for the editor preview and the render. The ffmpeg test needs ffmpeg on the PATH; it is skipped without it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIN_CLIP, PUNCH, buildAss, defaultEdit, defaultStyle, filterGraph, jumpCuts, normalizeEdit, normalizeStyle, styleOf, timeline, zoomAt } from "../edit.mjs";
import { renderClip, videoInfo } from "../render.mjs";

const hasFfmpeg = (() => { try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); return true; } catch { return false; } })();
// Speech from 2s to 4s, a 3s pause, speech from 7s to 9s, a 0.6s pause, then speech to 12s. The trim is 1s to 20s.
const words = [[2, 3, "one"], [3.1, 4, "two"], [7, 8, "three"], [8.1, 9, "four"], [9.6, 10.5, "five"], [10.6, 12, "six."]];
const quiet = Array(25).fill(0.1);
const make = (pace, over = {}) => normalizeEdit({ ...defaultEdit(normalizeStyle({ pace }), { trimStart: 1, trimEnd: 20 }), ...over }, { duration: 25 });

test("pace is part of the look: checked, kept by styleOf, off by default and for older saved looks", () => {
  assert.deepEqual(defaultStyle().pace, { cuts: "off", zooms: false });
  assert.deepEqual(normalizeStyle({ frame: { mode: "crop" } }).pace, { cuts: "off", zooms: false }, "a look saved before pace existed");
  assert.deepEqual(styleOf(make({ cuts: "tight", zooms: true })).pace, { cuts: "tight", zooms: true });
  assert.throws(() => normalizeStyle({ pace: { cuts: "brutal" } }), /Jump cuts/);
  assert.throws(() => normalizeStyle({ pace: { zooms: "yes" } }), /Punch-in zooms/);
});

test("jump cuts take out quiet pauses between words, keeping a little either side, and never the opening or ending", () => {
  assert.deepEqual(jumpCuts(make({ cuts: "off" }), words, quiet), []);
  // Gentle: only the 3s pause (4.25 to 6.75 in the source, so 3.25 to 5.75 into the trim).
  assert.deepEqual(jumpCuts(make({ cuts: "gentle" }), words, quiet), [[3.25, 5.75]]);
  // Tight: the 0.6s pause too, with less kept either side.
  assert.deepEqual(jumpCuts(make({ cuts: "tight" }), words, quiet), [[3.12, 5.88], [8.12, 8.48]]);
  // The silent second before the first word and the 8s after the last are not touched.
  const tl = timeline(make({ cuts: "gentle" }), words, quiet);
  assert.equal(tl.length, 19 - 2.5);
  assert.equal(tl.toClip(2), 2, "before the cut");
  assert.equal(tl.toClip(4), 3.25, "inside the cut: where it closes up");
  assert.equal(tl.toClip(10), 7.5, "after the cut: earlier by its length");
});

test("a pause full of sound (game audio, shouting) is kept, and without loudness only short pauses are cut", () => {
  const loud = [...quiet]; loud[5] = 0.8;
  assert.deepEqual(jumpCuts(make({ cuts: "gentle" }), words, loud), []);
  assert.deepEqual(jumpCuts(make({ cuts: "tight" }), words, loud), [[8.12, 8.48]]);
  assert.deepEqual(jumpCuts(make({ cuts: "tight" }), words, null), [[8.12, 8.48]], "the 3s pause is too long to cut unheard");
});

test("jump cuts stop before the clip would get shorter than the shortest clip", () => {
  const e = make({ cuts: "gentle" }, { trim: { start: 3.5, end: 9.5 } });
  assert.deepEqual(jumpCuts(e, words, quiet), []);
  assert.ok(timeline(e, words, quiet).length >= MIN_CLIP);
});

test("captions move to their place in the cut clip; the hook and progress bar use the cut clip's length", () => {
  const e = make({ cuts: "gentle" }, { hook: { text: "Wait", seconds: 90 }, progress: { on: true, color: "#ffffff" } });
  const tl = timeline(e, words, quiet), ass = buildAss(e, words, tl);
  // "three" starts 6s into the trim, 2.5s of pause earlier in the clip.
  assert.match(ass, /Dialogue: 0,0:00:03\.50,[^\n]*THREE/);
  assert.match(ass, /Dialogue: 1,0:00:00\.00,0:00:16\.50,Hook/);
  const graph = filterGraph(e, { width: 1280, height: 720 }, "c.ass", { tl, audio: { source: true } });
  assert.match(graph, /\[0:v\]fps=30,select='not\(between\(t,3\.25,5\.75\)\)',setpts=N\/30\/TB,/);
  assert.match(graph, /\[0:a\]aselect='not\(between\(t,3\.25,5\.75\)\)',asetpts=N\/SR\/TB,aresample=48000\[aout\]/);
  assert.match(graph, /t\/16\.5'/, "the progress bar fills over the cut length");
  assert.doesNotMatch(filterGraph(e, { width: 1280, height: 720 }, null, { tl, audio: { source: false } }), /aselect/, "a silent source has no sound to cut");
  assert.doesNotMatch(filterGraph(make({}), { width: 1280, height: 720 }, null), /select|zoompan/, "nothing changes with pace off");
});

test("punch-ins land on the loudest moments, spaced out, and zoom in and back out", () => {
  const energy = [...quiet]; energy[10] = 1; energy[11] = 0.9; energy[13] = 0.85; energy[17] = 0.8;
  const tl = timeline(make({ zooms: true }), words, energy);
  // Seconds 10 (loudest) and 17; 11 isn't a peak and 13 is within 5s of 10. Times are into the clip (trim starts at 1).
  assert.deepEqual(tl.punches, [9, 16]);
  assert.equal(zoomAt(tl.punches, 8.9), 1);
  assert.equal(zoomAt(tl.punches, 9 + PUNCH.rise + 0.5), 1 + PUNCH.zoom);
  assert.equal(zoomAt(tl.punches, 9 + PUNCH.rise + PUNCH.hold + PUNCH.fall), 1);
  assert.deepEqual(timeline(make({ zooms: false }), words, energy).punches, []);
  assert.deepEqual(timeline(make({ zooms: true }), words, null).punches, [], "no loudness, no zooms");
  // After the 2.5s jump cut the same moments come 2.5s earlier in the clip.
  const both = timeline(make({ cuts: "gentle", zooms: true }), words, energy);
  assert.deepEqual([both.cuts.length, both.punches], [1, [6.5, 13.5]]);
  // A loud pause is kept, not cut, so a zoom never lands inside a cut.
  const shout = [...quiet]; shout[5] = 1;
  const kept = timeline(make({ cuts: "gentle", zooms: true }), words, shout);
  assert.deepEqual([kept.cuts, kept.punches], [[], [4]]);
  const graph = filterGraph(make({ zooms: true }), { width: 1280, height: 720 }, null, { tl });
  assert.match(graph, /\[v0\]fps=30,zoompan=z='1\+0\.14\*min\(1,clip\(\(\(on\/30\)-9\)\/0\.15,0,1\)/);
  assert.match(graph, /s=720x1280:fps=30\[vz\]/);
});

test("renders a jump-cut, punched-in clip at the cut length with its sound", { skip: !hasFfmpeg && "ffmpeg not installed" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "clipflow-pace-"));
  try {
    const stream = join(dir, "stream.mp4");
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=1280x720:d=25:r=30", "-f", "lavfi", "-i", "sine=frequency=440:duration=25",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", stream]);
    const energy = [...quiet]; energy[15] = 1;
    const e = make({ cuts: "gentle", zooms: true }, { captions: { ...make({}).captions, on: true }, progress: { on: true, color: "#ffffff" } });
    const tl = timeline(e, words, energy);
    assert.deepEqual([tl.cuts.length, tl.punches.length], [1, 1]);
    const out = join(dir, "clip.mp4");
    const made = await renderClip(stream, { edit: e, words, width: 1280, height: 720, energy }, out, AbortSignal.timeout(180_000));
    assert.equal(made.duration, Math.round(tl.length));
    const info = await videoInfo(out, AbortSignal.timeout(30_000));
    assert.deepEqual([info.width, info.height], [720, 1280]);
    assert.ok(Math.abs(info.duration - tl.length) < 0.25, "the file is the cut length: " + info.duration + " vs " + tl.length);
    const audio = execFileSync("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=duration", "-of", "csv=p=0", out]).toString().trim();
    assert.ok(Math.abs(Number(audio) - tl.length) < 0.25, "the sound is cut too: " + audio);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
