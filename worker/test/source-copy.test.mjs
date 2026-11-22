import { test } from "node:test";
import assert from "node:assert/strict";
import { copyPlan, SOURCE_COPY_MAX } from "../media.mjs";

test("copyPlan copies the stream's video from the keyframe before, when it's small enough", () => {
  // A 120s window of a 3.4 Mbit/s stream (~51 MB); the source is 30s of it.
  const window = { rawBytes: 51_000_000, rawSeconds: 120 };
  assert.deepEqual(copyPlan({ ...window, from: 23.4, to: 60, keyframe: 22.03 }), { from: 22.03 }, "starts at the keyframe");
  assert.equal(copyPlan({ ...window, from: 23.4, to: 60, keyframe: null }), null, "no keyframe found: re-encode");
  assert.equal(copyPlan({ ...window, from: 40, to: 60, keyframe: 25 }), null, "a keyframe too far back: re-encode");
  // A 1080p60 stream at 8 Mbit/s: 100s would be ~100 MB, over the dashboard's limit.
  assert.equal(copyPlan({ rawBytes: 120_000_000, rawSeconds: 120, from: 10, to: 110, keyframe: 9 }), null, "too big: re-encode");
  assert.ok(SOURCE_COPY_MAX <= 64 * 1024 * 1024, "within what the dashboard accepts");
  process.env.SOURCE_COPY = "off";
  try { assert.equal(copyPlan({ ...window, from: 23.4, to: 60, keyframe: 22 }), null, "turned off"); } finally { delete process.env.SOURCE_COPY; }
});

test("lift: how far a moment's busiest 10 seconds stand out from the window's typical 10 seconds", async () => {
  const { lift } = await import("../media.mjs");
  const quiet = Array(120).fill(2);
  assert.equal(lift(quiet, 30, 70), 1, "nothing stands out");
  const spike = quiet.map((v, i) => i >= 50 && i < 60 ? 10 : v);
  assert.equal(lift(spike, 40, 80), 5, "chat five times its usual rate");
  assert.equal(lift(spike, 80, 110), 1, "the spike is outside this moment");
  assert.equal(lift([1, 2], 0, 2), null, "too short to say");
  assert.equal(lift(Array(60).fill(0), 0, 40), null, "no chat at all");
});
