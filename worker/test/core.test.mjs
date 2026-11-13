import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, allowed, channelUrl, dueForProbe, plan, probeResult, retryDelay, validateControl } from "../core.mjs";
import { captionStyle, frameFilter } from "../media.mjs";

const a = "11111111-1111-4111-8111-111111111111", b = "22222222-2222-4222-8222-222222222222", c = "33333333-3333-4333-8333-333333333333";
const config = (over = {}) => ({ control: "running", duration: 45, captions: true, dailyLimit: 2, streamers: [
  { id: a, url: "https://twitch.tv/alpha", status: "armed" },
  { id: b, url: "https://kick.com/beta", status: "armed" },
  { id: c, url: "https://youtube.com/@gamma", status: "paused" },
], ...over });
const ctx = (over = {}) => ({ running: new Set(), blockedUntil: new Map(), countToday: () => 0, now: 1000, maxCaptures: 1, isLive: () => true, ...over });

test("probeResult distinguishes live, offline and failed checks", () => {
  assert.deepEqual(probeResult({ plugin: "kick", metadata: { title: "Brand Risk #16" }, streams: { "720p60": {}, best: {} } }), { status: "live", title: "Brand Risk #16" });
  assert.deepEqual(probeResult({ error: "No playable streams found on this URL: https://kick.com/x" }), { status: "offline", title: null });
  assert.equal(probeResult({ error: "Error while querying Kick API: 404 Client Error" }).status, "error");
  assert.equal(probeResult({ streams: {} }).status, "error");
  assert.equal(probeResult(null).status, "error");
  assert.equal(probeResult({ streams: { best: {} }, metadata: { title: "x".repeat(500) } }).title.length, 200);
});

test("dueForProbe picks stale armed streamers, oldest first, within the limit", () => {
  const live = new Map([[a, { checkedAt: 900 }], [b, { checkedAt: 100 }]]);
  const opts = { running: new Set(), now: 1000, interval: 500, limit: 5 };
  assert.deepEqual(dueForProbe(config(), live, opts).map(s => s.id), [b], "a was checked recently; c is paused");
  assert.deepEqual(dueForProbe(config(), new Map(), { ...opts, limit: 1 }).map(s => s.id), [a]);
  assert.deepEqual(dueForProbe(config(), new Map(), { ...opts, running: new Set([a]) }).map(s => s.id), [b]);
  assert.deepEqual(dueForProbe(config({ control: "paused" }), new Map(), opts), []);
});

test("plan only starts captures for streamers confirmed live", () => {
  assert.deepEqual(plan(config(), ctx({ maxCaptures: 5, isLive: id => id === b })).start.map(s => s.id), [b]);
  assert.deepEqual(plan(config(), ctx({ isLive: () => false })).start, []);
});

test("channelUrl accepts channels and rejects non-channel pages", () => {
  assert.equal(channelUrl("https://www.twitch.tv/alpha"), "https://www.twitch.tv/alpha");
  assert.equal(channelUrl("https://youtube.com/@gamma"), "https://youtube.com/@gamma/live");
  for (const bad of ["http://twitch.tv/alpha", "https://twitch.tv/Following", "https://kick.com/downloads", "https://twitch.tv/a/b", "https://evil.com/alpha", "https://twitch.tv/alpha?x=1"])
    assert.throws(() => channelUrl(bad), bad);
});

test("validateControl requires a valid daily limit", () => {
  assert.equal(validateControl(config()).dailyLimit, 2);
  assert.throws(() => validateControl(config({ dailyLimit: 0 })));
  assert.throws(() => validateControl(config({ dailyLimit: undefined })));
  assert.throws(() => validateControl(config({ control: "on" })));
});

test("validateControl defaults and checks framing", () => {
  assert.equal(validateControl(config()).framing, "blur");
  assert.equal(validateControl(config({ framing: "crop" })).framing, "crop");
  assert.throws(() => validateControl(config({ framing: "stretch" })));
});

test("frameFilter always produces a 720x1280 graph", () => {
  assert.match(frameFilter("crop"), /crop=720:1280/);
  assert.match(frameFilter("fit"), /pad=720:1280/);
  assert.match(frameFilter("blur"), /^split\[bg\]\[fg\];.*overlay/);
  assert.equal(frameFilter(undefined), frameFilter("blur"));
});

test("captionStyle places captions under the picture only when there is room", () => {
  assert.match(captionStyle("blur", 1920, 1080), /Alignment=8,MarginV=879$/);
  assert.match(captionStyle("fit", 1280, 720), /Alignment=8,MarginV=879$/);
  assert.match(captionStyle("crop", 1920, 1080), /Alignment=2,MarginV=300$/);
  assert.match(captionStyle("blur", 1080, 1920), /Alignment=2,MarginV=300$/, "vertical source fills the frame");
  assert.match(captionStyle("blur", 0, 0), /Alignment=2,MarginV=300$/, "unknown size falls back to the lower third");
  assert.match(captionStyle("blur", 1920, 1080), /^PlayResX=720,PlayResY=1280,/);
});

test("allowed needs global running and an armed streamer", () => {
  assert.equal(allowed(config(), a), true);
  assert.equal(allowed(config(), c), false);
  assert.equal(allowed(config({ control: "paused" }), a), false);
  assert.equal(allowed(null, a), false);
});

test("plan respects capture slots, cooldowns and the daily limit", () => {
  assert.deepEqual(plan(config(), ctx()).start.map(s => s.id), [a]);
  assert.deepEqual(plan(config(), ctx({ maxCaptures: 5 })).start.map(s => s.id), [a, b]);
  assert.deepEqual(plan(config(), ctx({ blockedUntil: new Map([[a, 2000]]) })).start.map(s => s.id), [b]);
  assert.deepEqual(plan(config(), ctx({ countToday: id => (id === a ? 2 : 0) })).start.map(s => s.id), [b]);
  assert.deepEqual(plan(config(), ctx({ running: new Set([a]) })).start, []);
});

test("plan cancels captures when control or the streamer changes", () => {
  assert.deepEqual(plan(config({ control: "stopped" }), ctx({ running: new Set([a]) })), { start: [], stop: [a] });
  assert.deepEqual(plan(null, ctx({ running: new Set([a, b]) })).stop, [a, b]);
  const paused = config({ streamers: [{ id: a, url: "https://twitch.tv/alpha", status: "paused" }, { id: b, url: "https://kick.com/beta", status: "armed" }] });
  assert.deepEqual(plan(paused, ctx({ running: new Set([a]) })), { start: [paused.streamers[1]], stop: [a] });
});

test("retryDelay backs off to a five minute cap", () => {
  assert.equal(retryDelay(0), 30_000);
  assert.equal(retryDelay(1), 60_000);
  assert.equal(retryDelay(10), 300_000);
});

test("Store tracks clip states and recovers interrupted captures", () => {
  const dir = mkdtempSync(join(tmpdir(), "clipflow-"));
  try {
    let store = new Store(dir);
    store.add("x", a, "/tmp/x.mp4", 45, true);
    store.add("y", a, "/tmp/y.mp4", 45, false);
    assert.equal(store.countToday(a), 2);
    store.ready("x", "f".repeat(64));
    assert.deepEqual(store.pending().map(r => r.id), ["x"]);
    store.retry("x", 1);
    assert.deepEqual(store.pending(), []);
    store.close();
    store = new Store(dir);
    assert.equal(store.countToday(a), 1, "the unfinished capture is marked interrupted on restart");
    store.fail("x");
    assert.equal(store.countToday(a), 0);
    assert.equal(store.old(new Date(Date.now() + 1000).toISOString()).length, 2);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
