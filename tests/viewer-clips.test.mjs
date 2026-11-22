// Viewers' Twitch clips settings: the site (lib/viewer-clips.mjs) and the worker (worker/twitch.mjs) read them alike.
import { test } from "node:test";
import assert from "node:assert/strict";
import { effectiveViewerClips, readStreamerViewerClips, readViewerClips } from "../lib/viewer-clips.mjs";
import { viewerSettings } from "../worker/twitch.mjs";

test("workspace settings get defaults and lose anything out of range", () => {
  assert.deepEqual(readViewerClips(null), { perDay: 2, maxHours: 24, ask: false });
  assert.deepEqual(readViewerClips('{"perDay":5,"maxHours":6,"ask":true}'), { perDay: 5, maxHours: 6, ask: true });
  assert.deepEqual(readViewerClips({ perDay: 0, maxHours: 500, ask: "yes" }), { perDay: 2, maxHours: 24, ask: false });
  assert.deepEqual(readViewerClips("not json"), { perDay: 2, maxHours: 24, ask: false });
});

test("a streamer keeps only real choices", () => {
  assert.deepEqual(readStreamerViewerClips('{"on":true,"minViews":2000,"perDay":1,"maxHours":3,"ask":false,"extra":1}'), { on: true, minViews: 2000, perDay: 1, maxHours: 3, ask: false });
  assert.deepEqual(readStreamerViewerClips({ minViews: 0, perDay: 1.5, on: "no" }), {});
  assert.deepEqual(readStreamerViewerClips(null), {});
});

test("site and worker agree on what applies to a streamer", () => {
  const cases = [
    [0, null, null], [50, '{"perDay":3,"maxHours":12,"ask":true}', null], [50, null, '{"on":false}'], [0, null, '{"on":true}'],
    [10, '{"perDay":4}', '{"minViews":5000,"ask":true,"maxHours":6}'], [7, '{"perDay":99}', '{"perDay":-1}'],
  ];
  for (const [importClips, ws, own] of cases) {
    const site = effectiveViewerClips(importClips, ws, own);
    const worker = viewerSettings({ importClips, viewerClips: readViewerClips(ws) }, { viewerClips: readStreamerViewerClips(own) });
    assert.deepEqual(worker, site, JSON.stringify([importClips, ws, own]));
  }
});
