import { test } from "node:test";
import assert from "node:assert/strict";
import { timeAtX, xOf, rulerStep, cueBlocks } from "../app/editor/lanes.mjs";
import { layoutWarnings } from "../app/editor/warnings.mjs";

test("timeline: x to time and back, zoomed and scrolled", () => {
  assert.equal(timeAtX(400, 800, 40, 1, 0), 20);
  assert.equal(timeAtX(400, 800, 40, 2, 800), 30, "2x zoom, scrolled by one view width");
  assert.equal(xOf(30, 800, 40, 2), 1200);
  assert.equal(timeAtX(-50, 800, 40, 1, 0), 0, "clamped at the start");
  assert.equal(timeAtX(9000, 800, 40, 1, 0), 40, "clamped at the end");
  assert.equal(timeAtX(10, 800, 0, 1, 0), 0, "no duration yet");
});

test("timeline: ruler steps at least 60px apart", () => {
  assert.equal(rulerStep(40, 800, 1), 5);
  assert.equal(rulerStep(40, 800, 8), 1);
  assert.equal(rulerStep(600, 800, 1), 60);
});

test("timeline: subtitle blocks in source seconds", () => {
  assert.deepEqual(cueBlocks([{ start: 0, end: 1.5 }, { start: 2, end: 3 }], 10), [{ start: 10, end: 11.5 }, { start: 12, end: 13 }]);
});

test("warnings: edges, app buttons and overlap", () => {
  const frame = { W: 720, H: 1280 }, safe = { top: 120, right: 110, bottom: 300 };
  assert.deepEqual(layoutWarnings(frame, { hook: { left: 200, right: 520, top: 150, bottom: 260 }, captions: { left: 100, right: 620, top: 800, bottom: 900 } }, safe), []);
  assert.deepEqual(layoutWarnings(frame, { hook: { left: 10, right: 520, top: 150, bottom: 260 } }, safe), ["Title is close to the edge"]);
  assert.deepEqual(layoutWarnings(frame, { captions: { left: 100, right: 620, top: 1000, bottom: 1100 } }, safe), ["Subtitles are under the app buttons"]);
  assert.deepEqual(layoutWarnings(frame, { hook: { left: 200, right: 520, top: 780, bottom: 860 }, captions: { left: 100, right: 620, top: 800, bottom: 900 } }, safe), ["Title overlaps the subtitles"]);
  assert.deepEqual(layoutWarnings(frame, { captions: { left: 100, right: 700, top: 800, bottom: 900 } }, safe), ["Subtitles are close to the edge"]);
});
