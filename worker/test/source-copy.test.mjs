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
