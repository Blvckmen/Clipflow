import { test } from "node:test";
import assert from "node:assert/strict";
import { pieceArgs, HL_W, HL_H } from "../highlights-video.mjs";
import { validateControl } from "../core.mjs";

test("pieceArgs cuts the range, fills 1280x720 over a blur, fades, and makes silence when there's no audio", () => {
  const withSound = pieceArgs("in.mp4", "out.mp4", { start: 6, end: 36, audio: true }).join(" ");
  assert.match(withSound, /-ss 6 -t 30 -i in\.mp4/);
  assert.match(withSound, new RegExp("scale=" + HL_W + ":" + HL_H + ":force_original_aspect_ratio=increase"));
  assert.match(withSound, /fade=t=out:st=29\.60/);
  assert.match(withSound, /\[0:a\]aresample/);
  assert.doesNotMatch(withSound, /anullsrc/);
  const silent = pieceArgs("in.mp4", "out.mp4", { start: 0, end: 10, audio: false }).join(" ");
  assert.match(silent, /anullsrc=r=48000:cl=stereo/);
  assert.match(silent, /\[1:a\]aresample/);
});

test("validateControl accepts highlight requests and refuses malformed ones", () => {
  const base = { control: "running", duration: 45, dailyLimit: 5, captions: true, streamers: [] };
  const h = { id: "11111111-1111-4111-8111-111111111111", clips: [{ id: "22222222-2222-4222-8222-222222222222", start: 6, end: 36 }] };
  assert.deepEqual(validateControl({ ...base }).highlights, [], "older dashboards send none");
  assert.equal(validateControl({ ...base, highlights: [h] }).highlights[0].clips.length, 1);
  assert.throws(() => validateControl({ ...base, highlights: [{ ...h, clips: [{ ...h.clips[0], end: 5 }] }] }));
  assert.throws(() => validateControl({ ...base, highlights: [{ ...h, clips: [] }] }));
});
