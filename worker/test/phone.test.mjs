// Phone mode: finding the upright phone picture between black bars, and rendering it in each clip shape.
// The ffmpeg tests need ffmpeg on the PATH (the worker needs it anyway); they are skipped without it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findPhonePicture, phonePicture, renderClip, videoInfo } from "../render.mjs";
import { defaultEdit, normalizeStyle } from "../edit.mjs";

const hasFfmpeg = (() => { try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); return true; } catch { return false; } })();

test("an upright picture with bars beside it is a phone stream; a normal or letterboxed one isn't", () => {
  assert.deepEqual(phonePicture({ x: 656, y: 0, w: 608, h: 1080 }, 1920, 1080), { x: 0.3417, y: 0, w: 0.3167, h: 1 });
  assert.equal(phonePicture({ x: 0, y: 0, w: 1920, h: 1080 }, 1920, 1080), null, "fills the frame");
  assert.equal(phonePicture({ x: 0, y: 140, w: 1920, h: 800 }, 1920, 1080), null, "a letterboxed film");
  assert.equal(phonePicture({ x: 300, y: 0, w: 1300, h: 1080 }, 1920, 1080), null, "bars too thin to matter");
  assert.equal(phonePicture({ x: 800, y: 400, w: 200, h: 300 }, 1920, 1080), null, "a small dark-surrounded shape isn't a phone picture");
  assert.equal(phonePicture({ x: 0, y: 0, w: 0, h: 0 }, 0, 0), null);
});

test("finds the phone picture in a stream and renders it filling a portrait, square and landscape clip", { skip: !hasFfmpeg && "ffmpeg not installed" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "clipflow-phone-"));
  try {
    // A 1280x720 stream with a moving 404x720 test picture in the middle and black either side.
    const stream = join(dir, "stream.mp4");
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=black:s=1280x720:d=8:r=30", "-f", "lavfi", "-i", "testsrc2=s=404x720:d=8:r=30",
      "-filter_complex", "[0][1]overlay=438:0", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", stream]);
    const info = await videoInfo(stream, AbortSignal.timeout(30_000));
    const found = await findPhonePicture(stream, info, AbortSignal.timeout(60_000));
    assert.ok(found, "found a phone picture");
    assert.ok(Math.abs(found.x - 438 / 1280) < 0.01 && Math.abs(found.w - 404 / 1280) < 0.01 && found.y < 0.01 && found.h > 0.98, JSON.stringify(found));
    assert.equal(await findPhonePicture(stream, { ...info, width: 720, height: 1280 }, AbortSignal.timeout(5000)), null, "a portrait stream is never a phone stream");
    for (const [aspect, w, h] of [["9:16", 720, 1280], ["1:1", 960, 960], ["16:9", 1280, 720]]) {
      const edit = defaultEdit(normalizeStyle({ frame: { mode: "phone", aspect, content: found }, captions: { on: false } }), { trimStart: 1, trimEnd: 6.5 });
      const out = join(dir, "clip-" + aspect.replace(":", "x") + ".mp4");
      await renderClip(stream, { edit, words: [], width: info.width, height: info.height }, out, AbortSignal.timeout(120_000));
      const made = await videoInfo(out, AbortSignal.timeout(30_000));
      assert.deepEqual([made.width, made.height], [w, h], aspect + " clip size");
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
