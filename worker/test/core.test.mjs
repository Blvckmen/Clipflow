import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store, allowed, channelUrl, dueForProbe, plan, probeResult, retryDelay, validateControl } from "../core.mjs";
import { sourceSignals, sourceWords } from "../media.mjs";

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
  assert.deepEqual(probeResult({ error: "Error while querying Kick API: 404 Client Error" }), { status: "error", title: null, message: "Error while querying Kick API: 404 Client Error" });
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
  assert.equal(channelUrl("https://www.tiktok.com/@delta.live_1"), "https://www.tiktok.com/@delta.live_1/live");
  for (const bad of ["https://www.tiktok.com/@a/video/123", "https://www.tiktok.com/delta", "https://www.tiktok.com/@a"]) assert.throws(() => channelUrl(bad), bad);
  for (const bad of ["http://twitch.tv/alpha", "https://twitch.tv/Following", "https://kick.com/downloads", "https://twitch.tv/a/b", "https://evil.com/alpha", "https://twitch.tv/alpha?x=1"])
    assert.throws(() => channelUrl(bad), bad);
});

test("validateControl requires a valid daily limit", () => {
  assert.equal(validateControl(config()).dailyLimit, 2);
  assert.throws(() => validateControl(config({ dailyLimit: 0 })));
  assert.equal(validateControl(config({ dailyLimit: 100 })).dailyLimit, 100, "up to 100 a day");
  assert.throws(() => validateControl(config({ dailyLimit: 101 })));
  assert.throws(() => validateControl(config({ dailyLimit: undefined })));
  assert.throws(() => validateControl(config({ control: "on" })));
});

test("validateControl defaults and checks framing", () => {
  assert.equal(validateControl(config()).framing, "blur");
  assert.equal(validateControl(config({ framing: "crop" })).framing, "crop");
  assert.throws(() => validateControl(config({ framing: "stretch" })));
});

test("validateControl accepts render requests and streamer styles, and rejects malformed ones", () => {
  const render = { id: a, rev: 2, edit: { trim: { start: 0, end: 20 } } };
  assert.deepEqual(validateControl(config()).renders, [], "older dashboards send none");
  assert.equal(validateControl(config({ renders: [render] })).renders[0].rev, 2);
  assert.throws(() => validateControl(config({ renders: [{ ...render, rev: 0 }] })));
  assert.throws(() => validateControl(config({ renders: [{ ...render, id: "x" }] })));
  assert.throws(() => validateControl(config({ renders: "all" })));
  assert.equal(validateControl(config({ streamers: [{ id: a, url: "https://twitch.tv/alpha", status: "armed", style: { frame: { mode: "crop" } } }] })).streamers[0].style.frame.mode, "crop");
  assert.throws(() => validateControl(config({ streamers: [{ id: a, url: "https://twitch.tv/alpha", status: "armed", style: "loud" }] })));
});

test("sourceWords keeps words inside the source and shifts them to its start", () => {
  const segments = [{ words: [[9, 9.5, " too early"], [10.2, 10.6, " Hello"], [10.7, 11, " {big}\\ world!"], [19.5, 20.5, " too late"]] }];
  assert.deepEqual(sourceWords(segments, 10, 20), [[0.2, 0.6, "Hello"], [0.7, 1, "big world!"]]);
});

test("sourceSignals scales loudness to the loudest second and lines chat up with it", () => {
  assert.deepEqual(sourceSignals([0, 1, 2, 4, 8], [0, 3, 0, 9], 1, 4), { energy: [0.25, 0.5, 1], chat: [3, 0, 9] });
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
  assert.deepEqual(plan(config({ control: "stopped" }), ctx({ running: new Set([a]) })), { start: [], stop: [a], bump: [] });
  assert.deepEqual(plan(null, ctx({ running: new Set([a, b]) })).stop, [a, b]);
  const paused = config({ streamers: [{ id: a, url: "https://twitch.tv/alpha", status: "paused" }, { id: b, url: "https://kick.com/beta", status: "armed" }] });
  assert.deepEqual(plan(paused, ctx({ running: new Set([a]) })), { start: [paused.streamers[1]], stop: [a], bump: [] });
});

test("plan gives full slots to higher-priority streamers first", () => {
  const d = "44444444-4444-4444-8444-444444444444";
  const ranked = config({ streamers: [a, b, c, d].map((id, i) => ({ id, url: "https://twitch.tv/s" + i, status: "armed" })) });
  // Free slots go down the list in order.
  assert.deepEqual(plan(ranked, ctx({ maxCaptures: 2 })).start.map(s => s.id), [a, b]);
  // Full: a (ranked first) takes the slot of the lowest-ranked capture, d.
  let p = plan(ranked, ctx({ maxCaptures: 2, running: new Set([c, d]) }));
  assert.deepEqual(p.start.map(s => s.id), [a, b], "b outranks c too");
  assert.deepEqual(p.bump, [d, c]);
  p = plan(ranked, ctx({ maxCaptures: 2, running: new Set([b, d]) }));
  assert.deepEqual([p.start.map(s => s.id), p.bump], [[a], [d]], "c ranks below b, so only d gives way");
  // A lower-ranked streamer never takes a higher-ranked one's slot.
  p = plan(ranked, ctx({ maxCaptures: 2, running: new Set([a, b]) }));
  assert.deepEqual([p.start, p.bump], [[], []]);
  // A streamer that can't start (offline, cooling down) takes nothing.
  p = plan(ranked, ctx({ maxCaptures: 1, running: new Set([d]), isLive: id => id !== a, blockedUntil: new Map([[b, 2000]]) }));
  assert.deepEqual([p.start.map(s => s.id), p.bump], [[c], [d]]);
});

test("Store finds clips interrupted by a stop and resumes them", () => {
  const dir = mkdtempSync(join(tmpdir(), "store-")), store = new Store(dir);
  try {
    store.add("a", "s1", "/x/a/clip.mp4", 45, true, "chat");
    store.add("b", "s1", "/x/b/clip.mp4", 45, true, "audio");
    store.db.prepare("UPDATE clips SET state='interrupted'").run();
    store.db.prepare("UPDATE clips SET created_at=? WHERE id='b'").run("2000-01-01T00:00:00.000Z");
    assert.deepEqual(store.interrupted(new Date(Date.now() - 86_400_000).toISOString()).map(r => r.id), ["a"], "only the last day's");
    assert.equal(store.countToday("s1"), 0, "interrupted clips don't count towards the limit");
    store.resume("a");
    assert.equal(store.db.prepare("SELECT state FROM clips WHERE id='a'").get().state, "capturing");
    assert.equal(store.countToday("s1"), 1, "resumed ones do");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("retryDelay backs off to a five minute cap", () => {
  assert.equal(retryDelay(0), 30_000);
  assert.equal(retryDelay(1), 60_000);
  assert.equal(retryDelay(10), 300_000);
});

test("Store adds the reason column to databases created before it existed", () => {
  const dir = mkdtempSync(join(tmpdir(), "clipflow-"));
  try {
    const old = new DatabaseSync(join(dir, "worker.sqlite"));
    old.exec("CREATE TABLE clips (id TEXT PRIMARY KEY, streamer TEXT NOT NULL, path TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, duration INTEGER NOT NULL, captions INTEGER NOT NULL, sha TEXT, attempts INTEGER NOT NULL DEFAULT 0, next_try INTEGER NOT NULL DEFAULT 0)");
    old.close();
    const store = new Store(dir);
    store.add("z", a, "/tmp/z.mp4", 30, true, "audio");
    store.ready("z", "f".repeat(64), 31);
    assert.deepEqual(store.pending().map(r => [r.reason, r.duration]), [["audio", 31]]);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Store tracks clip states and recovers interrupted captures", () => {
  const dir = mkdtempSync(join(tmpdir(), "clipflow-"));
  try {
    let store = new Store(dir);
    store.add("x", a, "/tmp/x.mp4", 45, true, "chat");
    store.add("y", a, "/tmp/y.mp4", 45, false);
    assert.equal(store.countToday(a), 2);
    store.ready("x", "f".repeat(64));
    assert.deepEqual(store.pending().map(r => [r.id, r.reason]), [["x", "chat"]]);
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

test("validateControl defaults transcription on and rejects other values", () => {
  assert.equal(validateControl(config()).transcribe, true, "older dashboards omit it");
  assert.equal(validateControl(config({ transcribe: false })).transcribe, false);
  assert.throws(() => validateControl(config({ transcribe: "no" })));
});

test("validateControl accepts split screen and the background library", () => {
  const c = validateControl(config({ framing: "split", backgrounds: [{ id: "11111111-1111-4111-8111-111111111111", size: 100 }] }));
  assert.deepEqual([c.framing, c.backgrounds.length], ["split", 1]);
  assert.deepEqual(validateControl(config()).backgrounds, [], "older dashboards send none");
});

test("transcription, subtitles and hooks: the streamer's own choice, else the workspace's", async () => {
  const { clipTextFor } = await import("../core.mjs");
  const ws = { transcribe: true, captions: true };
  assert.deepEqual(clipTextFor(ws, { text: {} }), { transcribe: true, subtitles: true, hook: true });
  assert.deepEqual(clipTextFor(ws, { text: { subtitles: false } }), { transcribe: true, subtitles: false, hook: true });
  assert.deepEqual(clipTextFor({ transcribe: true, captions: false }, { text: { subtitles: true, hook: false } }), { transcribe: true, subtitles: true, hook: false });
  assert.deepEqual(clipTextFor(ws, { text: { transcribe: false, subtitles: true, hook: true } }), { transcribe: false, subtitles: false, hook: false }, "no transcript, no text");
  assert.deepEqual(clipTextFor({ transcribe: false, captions: true }, { text: { transcribe: true } }), { transcribe: true, subtitles: true, hook: true });
  assert.deepEqual(clipTextFor(ws, undefined), { transcribe: true, subtitles: true, hook: true }, "a removed streamer follows the workspace");
  assert.deepEqual(validateControl(config({ streamers: [{ ...config().streamers[0], text: { hook: false } }] })).streamers[0].text, { hook: false });
  assert.deepEqual(validateControl(config()).streamers[0].text, {}, "older dashboards");
  assert.throws(() => validateControl(config({ streamers: [{ ...config().streamers[0], text: { hook: "no" } }] })), /text settings/);
  assert.throws(() => validateControl(config({ streamers: [{ ...config().streamers[0], text: { captions: true } }] })), /text settings/);
});

test("viewers' Twitch clips have their own daily count, apart from the daily clip limit", () => {
  const dir = mkdtempSync(join(tmpdir(), "store-")), store = new Store(dir);
  try {
    store.add("a", "s1", "/x/a/clip.mp4", 45, true, "chat");
    store.add("v1", "s1", "/x/v1/clip.mp4", 30, true, "viewer");
    store.add("v2", "s1", "/x/v2/clip.mp4", 30, true, "viewer");
    assert.equal(store.countToday("s1"), 1);
    assert.equal(store.countViewerToday("s1"), 2);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
