// API integration tests. They run against a local dev server with mock sign-in:
//   npm run dev -- --port 5199      (in another terminal)
//   npm run test:api                (BASE_URL defaults to http://127.0.0.1:5199)
// Tests create their own streamer and clips and delete them afterwards, but they do
// rotate the mock user's worker token and leave global control paused.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

const base = process.env.BASE_URL ?? "http://127.0.0.1:5199";
let cookie = "", token = "", streamer, originalSettings;

async function dash(body) {
  const response = await fetch(base + "/api/dashboard", body ? { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) } : { headers: { cookie } });
  return { status: response.status, body: await response.json() };
}
const worker = (path, init = {}) => fetch(base + path, { ...init, headers: { authorization: "Bearer " + token, "content-type": "application/json", ...init.headers } });
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
async function reportClip(bytes, over = {}) {
  const clip = { id: randomUUID(), streamerId: streamer.id, createdAt: new Date().toISOString(), duration: 30, captions: true, sha: sha256(bytes), size: bytes.length, ...over };
  const response = await worker("/api/worker/clips", { method: "POST", body: JSON.stringify(clip) });
  return { clip, response };
}
const upload = (id, bytes) => worker("/api/worker/clips/" + id + "/file", { method: "PUT", headers: { "content-type": "video/mp4" }, body: bytes });

before(async () => {
  try { await fetch(base + "/api/dashboard"); } catch { throw new Error("No dev server at " + base + ". Start it with: npm run dev -- --port 5199"); }
  const signin = await fetch(base + "/signin-with-chatgpt?return_to=/", { redirect: "manual" });
  cookie = signin.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
  assert.ok(cookie, "mock sign-in should set a cookie");
  originalSettings = (await dash()).body.settings;
  const name = "apitest" + Date.now().toString(36);
  assert.equal((await dash({ action: "add", url: "https://twitch.tv/" + name })).status, 200);
  streamer = (await dash()).body.streamers.find(s => s.url === "https://twitch.tv/" + name);
  token = (await dash({ action: "token" })).body.token;
});

after(async () => {
  if (!cookie) return;
  const { body } = await dash();
  for (const clip of body.clips?.filter(c => c.streamer_id === streamer?.id) ?? []) await dash({ action: "deleteClip", id: clip.id });
  if (streamer) await dash({ action: "remove", id: streamer.id });
  if (originalSettings) {
    const { mode, duration, dailyLimit, captions, framing, destinations } = originalSettings;
    await dash({ action: "settings", settings: { mode, duration, dailyLimit, captions, framing, destinations } });
  }
  await dash({ action: "control", control: "paused" });
});

describe("dashboard", () => {
  test("rejects anonymous requests", async () => {
    assert.equal((await fetch(base + "/api/dashboard")).status, 401);
  });
  test("rejects invalid channel URLs and duplicates", async () => {
    assert.equal((await dash({ action: "add", url: "https://twitch.tv/directory" })).status, 400);
    assert.equal((await dash({ action: "add", url: "https://example.com/someone" })).status, 400);
    assert.equal((await dash({ action: "add", url: streamer.url })).status, 409);
  });
  test("control accepts running, paused and stopped", async () => {
    for (const control of ["running", "stopped", "paused"]) {
      assert.equal((await dash({ action: "control", control })).status, 200);
      assert.equal((await dash()).body.settings.control, control);
    }
    assert.equal((await dash({ action: "control", control: "on" })).status, 400);
  });
});

describe("worker token", () => {
  test("config requires a valid token", async () => {
    assert.equal((await fetch(base + "/api/worker/config")).status, 401);
    assert.equal((await fetch(base + "/api/worker/config", { headers: { authorization: "Bearer cfw_" + "0".repeat(64) } })).status, 401);
  });
  test("config returns the owner's streamers and settings", async () => {
    const config = await (await worker("/api/worker/config")).json();
    assert.ok(["running", "paused", "stopped"].includes(config.control));
    assert.ok(config.streamers.some(s => s.id === streamer.id && s.url === streamer.url));
    for (const key of ["duration", "dailyLimit", "captions", "framing"]) assert.ok(key in config, key);
  });
  test("framing round-trips to the worker config and invalid values are rejected", async () => {
    const { mode, duration, dailyLimit, captions, destinations } = originalSettings;
    for (const framing of ["crop", "fit", "blur"]) {
      assert.equal((await dash({ action: "settings", settings: { mode, duration, dailyLimit, captions, destinations, framing } })).status, 200);
      assert.equal((await (await worker("/api/worker/config")).json()).framing, framing);
    }
    assert.equal((await dash({ action: "settings", settings: { mode, duration, dailyLimit, captions, destinations, framing: "stretch" } })).status, 400);
  });
  test("replacing the token revokes the old one", async () => {
    const old = token;
    token = (await dash({ action: "token" })).body.token;
    assert.equal((await fetch(base + "/api/worker/config", { headers: { authorization: "Bearer " + old } })).status, 401);
    assert.equal((await worker("/api/worker/config")).status, 200);
    assert.equal((await dash()).body.engine.connected, true, "a config poll marks the worker connected");
  });
});

describe("live status", () => {
  test("worker status reports appear on the streamer", async () => {
    const checkedAt = new Date().toISOString();
    const response = await worker("/api/worker/status", { method: "POST", body: JSON.stringify({ streamers: [{ id: streamer.id, status: "live", checkedAt, title: "API test stream" }] }) });
    assert.equal(response.status, 200);
    const row = (await dash()).body.streamers.find(s => s.id === streamer.id);
    assert.deepEqual([row.live_status, row.live_checked_at, row.live_title], ["live", checkedAt, "API test stream"]);
  });
  test("the worker's latest error is shown and a new token clears it", async () => {
    const at = new Date().toISOString();
    const sent = await worker("/api/worker/status", { method: "POST", body: JSON.stringify({ streamers: [], error: { message: "ffmpeg failed (exit 1): No such file", at } }) });
    assert.equal(sent.status, 200);
    let engine = (await dash()).body.engine;
    assert.deepEqual([engine.lastError, engine.lastErrorAt], ["ffmpeg failed (exit 1): No such file", at]);
    const tooLong = await worker("/api/worker/status", { method: "POST", body: JSON.stringify({ streamers: [], error: { message: "x".repeat(501), at } }) });
    assert.equal(tooLong.status, 400);
    token = (await dash({ action: "token" })).body.token;
    engine = (await dash()).body.engine;
    assert.equal(engine.lastError, null);
  });
  test("invalid status reports are rejected", async () => {
    const bad = await worker("/api/worker/status", { method: "POST", body: JSON.stringify({ streamers: [{ id: streamer.id, status: "streaming", checkedAt: new Date().toISOString() }] }) });
    assert.equal(bad.status, 400);
  });
});

describe("clips", () => {
  const bytes = Buffer.alloc(4096, 7);
  let clip;
  test("report is idempotent and owner-checked", async () => {
    const first = await reportClip(bytes);
    clip = first.clip;
    assert.equal(first.response.status, 200);
    const again = await worker("/api/worker/clips", { method: "POST", body: JSON.stringify(clip) });
    assert.deepEqual(await again.json(), { ok: true, duplicate: true });
    assert.equal((await reportClip(bytes, { streamerId: randomUUID() })).response.status, 404);
    assert.equal((await reportClip(bytes, { sha: "nope" })).response.status, 400);
    assert.equal((await dash()).body.clips.filter(c => c.id === clip.id).length, 1);
  });
  test("upload must match the reported sha and size", async () => {
    assert.equal((await upload(clip.id, Buffer.alloc(4096, 8))).status, 422);
    assert.equal((await upload(clip.id, Buffer.alloc(2048, 7))).status, 422);
    assert.equal((await upload(randomUUID(), bytes)).status, 404);
    assert.equal((await fetch(base + "/api/worker/clips/" + clip.id + "/file", { method: "PUT", body: bytes })).status, 401);
    assert.equal((await dash()).body.clips.find(c => c.id === clip.id).stored, false);
  });
  test("a matching upload is stored once and playable by its owner", async () => {
    assert.equal((await upload(clip.id, bytes)).status, 200);
    assert.deepEqual(await (await upload(clip.id, bytes)).json(), { ok: true, duplicate: true });
    assert.equal((await dash()).body.clips.find(c => c.id === clip.id).stored, true);
    const file = base + "/api/clips/" + clip.id + "/file";
    const full = await fetch(file, { headers: { cookie } });
    assert.equal(full.status, 200);
    assert.equal(full.headers.get("content-type"), "video/mp4");
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes);
    const ranged = await fetch(file, { headers: { cookie, range: "bytes=100-199" } });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get("content-range"), "bytes 100-199/4096");
    assert.equal((await ranged.arrayBuffer()).byteLength, 100);
    const download = await fetch(file + "?download=1", { headers: { cookie } });
    assert.match(download.headers.get("content-disposition"), /^attachment; filename="clip-.*\.mp4"$/);
    await download.arrayBuffer();
    assert.equal((await fetch(file)).status, 401);
    assert.equal((await fetch(base + "/api/clips/" + randomUUID() + "/file", { headers: { cookie } })).status, 404);
  });
  test("publishing mode decides the starting review state and the trigger reason is kept", async () => {
    const { duration, dailyLimit, captions, framing, destinations } = originalSettings;
    const setMode = m => dash({ action: "settings", settings: { mode: m, duration, dailyLimit, captions, framing, destinations } });
    await setMode("review");
    const held = (await reportClip(Buffer.alloc(2048, 1), { reason: "chat" })).clip;
    await setMode("automatic");
    const auto = (await reportClip(Buffer.alloc(2048, 2), { reason: "audio" })).clip;
    const listed = (await dash()).body.clips;
    const row = id => listed.find(c => c.id === id);
    assert.deepEqual([row(held.id).review, row(held.id).reason], ["pending", "chat"]);
    assert.deepEqual([row(auto.id).review, row(auto.id).reason], ["approved", "audio"]);
    assert.equal((await reportClip(Buffer.alloc(2048, 3), { reason: "vibes" })).response.status, 400);
    assert.match((await dash()).body.events[0].message, /at its loudest moment\.$/);
  });
  test("review decisions are saved, validated and owner-checked", async () => {
    const pending = (await dash()).body.clips.find(c => c.streamer_id === streamer.id && c.review === "pending");
    for (const decision of ["approved", "rejected", "pending"]) {
      const result = await dash({ action: "reviewClip", id: pending.id, review: decision });
      assert.equal(result.status, 200);
      assert.equal((await dash()).body.clips.find(c => c.id === pending.id).review, decision);
    }
    assert.equal((await dash({ action: "reviewClip", id: pending.id, review: "maybe" })).status, 400);
    assert.equal((await dash({ action: "reviewClip", id: randomUUID(), review: "approved" })).status, 404);
  });
  test("delete removes the record and the stored file", async () => {
    assert.equal((await dash({ action: "deleteClip", id: clip.id })).status, 200);
    assert.equal((await fetch(base + "/api/clips/" + clip.id + "/file", { headers: { cookie } })).status, 404);
    assert.equal((await dash()).body.clips.some(c => c.id === clip.id), false);
    assert.equal((await dash({ action: "deleteClip", id: clip.id })).status, 404);
  });
});
