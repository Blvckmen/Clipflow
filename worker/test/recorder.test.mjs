import { test } from "node:test";
import assert from "node:assert/strict";
import { Recorder } from "../recorder.mjs";

test("footageMs moves times after a resume gap back by the gap and drops times inside it", () => {
  const r = new Recorder("https://example.invalid/x", "unused");
  r.gaps = [{ fromMs: 10_000, toMs: 15_000 }, { fromMs: 30_000, toMs: 32_000 }];
  assert.equal(r.footageMs(5_000), 5_000);
  assert.equal(r.footageMs(12_000), null);
  assert.equal(r.footageMs(15_000), 10_000);
  assert.equal(r.footageMs(40_000), 33_000);
});
