import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, plan, validateControl } from "../core.mjs";
import { bucketSignals, parts, pickMoments, segmentFiles } from "../recordings.mjs";

const a = "11111111-1111-4111-8111-111111111111", b = "22222222-2222-4222-8222-222222222222", r = "44444444-4444-4444-8444-444444444444", q = "55555555-5555-4555-8555-555555555555";
const config = (over = {}) => ({ control: "running", duration: 45, captions: true, dailyLimit: 2, streamers: [
  { id: a, url: "https://twitch.tv/alpha", status: "armed", captureMode: "record" },
  { id: b, url: "https://kick.com/beta", status: "armed" },
], ...over });

test("validateControl defaults capture modes, retention and clip requests for older dashboards", () => {
  const c = validateControl(config());
  assert.equal(c.streamers[0].captureMode, "record");
  assert.equal(c.streamers[1].captureMode, "clip");
  assert.equal(c.recordingDays, 7);
  assert.equal(c.recordings, null);
  assert.deepEqual(c.clipRequests, []);
});

test("validateControl checks capture modes and clip requests", () => {
  assert.throws(() => validateControl(config({ streamers: [{ id: a, url: "https://twitch.tv/alpha", status: "armed", captureMode: "archive" }] })), /capture mode/);
  assert.throws(() => validateControl(config({ recordingDays: 0 })), /retention/);
  const ok = validateControl(config({ recordings: [r], clipRequests: [{ id: q, recordingId: r, kind: "moment", start: 100, end: 130 }, { id: a, recordingId: r, kind: "best", count: 3 }] }));
  assert.equal(ok.clipRequests.length, 2);
  // Clips are 15 to 90 seconds.
  assert.throws(() => validateControl(config({ clipRequests: [{ id: q, recordingId: r, kind: "moment", start: 100, end: 105 }] })), /range/);
  assert.throws(() => validateControl(config({ clipRequests: [{ id: q, recordingId: r, kind: "moment", start: 0, end: 200 }] })), /range/);
  assert.throws(() => validateControl(config({ clipRequests: [{ id: q, recordingId: r, kind: "best", count: 0 }] })), /count/);
  assert.throws(() => validateControl(config({ recordings: ["nope"] })), /recordings/);
});

test("plan keeps recording a streamer past the daily clip limit, but not a clip-only one", () => {
  const c = validateControl(config());
  const { start } = plan(c, { running: new Set(), blockedUntil: new Map(), countToday: () => 5, now: 1000, maxCaptures: 3, isLive: () => true });
  assert.deepEqual(start.map(s => s.id), [a]);
});

test("pickMoments takes the loudest separate moments, in time order", () => {
  const energy = Array(600).fill(1);
  for (let i = 100; i < 130; i++) energy[i] = 50;   // loudest
  for (let i = 400; i < 430; i++) energy[i] = 30;   // second
  for (let i = 110; i < 140; i++) energy[i] = Math.max(energy[i], 40);  // overlaps the first: not a separate moment
  const starts = pickMoments({ energy, duration: 30, count: 2, gap: 10 });
  assert.equal(starts.length, 2);
  assert.ok(starts[0] >= 95 && starts[0] <= 115, "first moment around 100-130, got " + starts[0]);
  assert.ok(starts[1] >= 395 && starts[1] <= 405, "second moment around 400, got " + starts[1]);
  assert.ok(starts[1] - starts[0] >= 40);
});

test("pickMoments uses chat a few seconds after the moment, skips the opening, and handles short recordings", () => {
  const energy = Array(300).fill(1), chat = Array(300).fill(0);
  for (let i = 204; i < 224; i++) chat[i] = 20;  // viewers react ~4s after 200
  const [start] = pickMoments({ energy, chat, duration: 20, count: 1 });
  assert.ok(Math.abs(start - 200) <= 2, "expected ~200, got " + start);
  const loudStart = Array(300).fill(1); for (let i = 0; i < 20; i++) loudStart[i] = 99;
  assert.ok(pickMoments({ energy: loudStart, duration: 20, count: 1, skip: 60 })[0] >= 60);
  assert.deepEqual(pickMoments({ energy: Array(10).fill(1), duration: 20, count: 3 }), []);
  assert.equal(pickMoments({ energy: Array(100).fill(1), duration: 20, count: 10, gap: 10 }).length, 3);
});

test("bucketSignals fits a long stream into a bounded strip", () => {
  const hours = 4 * 3600, energy = Array.from({ length: hours }, (_, i) => (i % 100) + 1), chat = Array(hours).fill(1);
  const s = bucketSignals(energy, chat, 2000);
  assert.equal(s.step, 8);
  assert.equal(s.energy.length, 1800);
  assert.ok(s.energy.every(v => v >= 0 && v <= 1));
  assert.equal(s.chat[0], 8);
  assert.deepEqual(bucketSignals([0, 0], [], 10).energy, [0, 0]);
});

test("parts splits a file into equal parts with a shorter last one", () => {
  assert.deepEqual(parts(250, 100), [{ number: 1, offset: 0, length: 100 }, { number: 2, offset: 100, length: 100 }, { number: 3, offset: 200, length: 50 }]);
  assert.deepEqual(parts(100, 100), [{ number: 1, offset: 0, length: 100 }]);
});

test("segmentFiles follows ffmpeg's list, then adds unlisted segments by name", async () => {
  const dir = mkdtempSync(join(tmpdir(), "clipflow-seg-"));
  try {
    for (const f of ["seg000000.m2t", "seg000001.m2t", "seg000002.m2t"]) writeFileSync(join(dir, f), "x");
    writeFileSync(join(dir, "list.csv"), "seg000001.m2t,0,6\nseg000000.m2t,6,12\nseg000009.m2t,12,18\n");
    assert.deepEqual(await segmentFiles(dir), ["seg000001.m2t", "seg000000.m2t", "seg000002.m2t"]);
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test("Store keeps recordings and finishes ones cut short by a restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "clipflow-rec-"));
  try {
    let store = new Store(dir);
    store.addRecording(r, a, join(dir, "r"), "record");
    store.setRecording(r, { title: "Finals", reported: 1 });
    assert.equal(store.recording(r).state, "recording");
    store.close();
    store = new Store(dir);
    const row = store.recording(r);
    assert.equal(row.state, "ended");
    assert.equal(row.title, "Finals");
    assert.ok(row.ended_at);
    store.removeRecording(r);
    assert.equal(store.recordings().length, 0);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
