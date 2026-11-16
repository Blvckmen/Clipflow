// API integration tests. They run against a local dev server with mock sign-in:
//   npm run dev -- --port 5199      (in another terminal)
//   npm run test:api                (BASE_URL defaults to http://127.0.0.1:5199)
// Tests create their own streamer and clips and delete them afterwards, but they do
// rotate the mock user's worker token and leave global control paused.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { defaultEdit, defaultStyle } from "../worker/edit.mjs";

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
  test("TikTok profiles can be added and appear in the worker's config", async () => {
    const handle = "apitt" + Date.now().toString(36);
    const added = await dash({ action: "add", url: "https://www.tiktok.com/@" + handle.toUpperCase() + "/live" });
    assert.equal(added.status, 200);
    const row = (await dash()).body.streamers.find(s => s.id === added.body.streamerId);
    assert.deepEqual([row.platform, row.url, row.name], ["TikTok", "https://www.tiktok.com/@" + handle, handle]);
    assert.equal((await dash({ action: "add", url: "https://tiktok.com/@" + handle })).status, 409, "same profile, different spelling");
    for (const bad of ["https://www.tiktok.com/@" + handle + "/video/7300000000000000000", "https://www.tiktok.com/foryou", "https://www.tiktok.com/@a"])
      assert.equal((await dash({ action: "add", url: bad })).status, 400, bad);
    await dash({ action: "remove", id: row.id });
    await dash({ action: "control", control: "paused" });
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

describe("streamers start clipping and route to accounts", () => {
  test("adding a streamer switches automation on and returns its id", async () => {
    await dash({ action: "control", control: "paused" });
    const name = "apistart" + Date.now().toString(36);
    const added = await dash({ action: "add", url: "https://kick.com/" + name });
    assert.equal(added.status, 200);
    assert.match(added.body.message, /Clipping starts as soon as they go live/);
    const { body } = await dash();
    assert.equal(body.settings.control, "running");
    const row = body.streamers.find(s => s.id === added.body.streamerId);
    assert.deepEqual(row.accounts, [], "no account picked: library only");
    assert.equal((await dash({ action: "remove", id: row.id })).status, 200);
    await dash({ action: "control", control: "paused" });
  });
  test("only the owner's own accounts can be linked", async () => {
    assert.equal((await dash({ action: "add", url: "https://kick.com/apibad" + Date.now().toString(36), accounts: [randomUUID()] })).status, 404);
    assert.equal((await dash({ action: "assign", streamerId: streamer.id, accounts: [randomUUID()] })).status, 404);
    assert.equal((await dash({ action: "assign", streamerId: randomUUID(), accounts: [] })).status, 404);
    const cleared = await dash({ action: "assign", streamerId: streamer.id, accounts: [] });
    assert.equal(cleared.status, 200);
    assert.match(cleared.body.message, /kept in the library and not posted/);
  });
  test("a streamer's saved look reaches the worker, and bad looks are refused", async () => {
    const style = { ...defaultStyle(), frame: { mode: "crop", zoom: 1.4, x: 0.2, y: 0 } };
    assert.equal((await dash({ action: "style", streamerId: streamer.id, style })).status, 200);
    let config = await (await worker("/api/worker/config")).json();
    assert.equal(config.streamers.find(s => s.id === streamer.id).style.frame.zoom, 1.4);
    const bad = await dash({ action: "style", streamerId: streamer.id, style: { ...style, captions: { font: "Papyrus" } } });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /Font/);
    assert.equal((await dash({ action: "style", style })).status, 200, "workspace look");
    config = await (await worker("/api/worker/config")).json();
    assert.equal(config.style.frame.mode, "crop");
    await dash({ action: "style", streamerId: streamer.id, style: null });
    await dash({ action: "style", style: null });
    config = await (await worker("/api/worker/config")).json();
    assert.equal(config.streamers.find(s => s.id === streamer.id).style, null);
    assert.equal(config.style, null);
  });
});

describe("clip editor", () => {
  const file = Buffer.alloc(5000, 4), source = Buffer.alloc(9000, 5);
  const words = [[6.2, 6.6, "Hello"], [6.7, 7.1, "chat!"]];
  const firstEdit = defaultEdit(defaultStyle(), { trimStart: 6, trimEnd: 36 });
  let clip;
  const edit = id => fetch(base + "/api/clips/" + id + "/edit", { headers: { cookie } });
  const save = (id, body) => fetch(base + "/api/clips/" + id + "/edit", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
  const render = (id, bytes, rev, sha = sha256(bytes)) => worker("/api/worker/clips/" + id + "/render", { method: "PUT", headers: { "content-type": "video/mp4", "x-edit-rev": String(rev), "x-clip-sha256": sha }, body: bytes });

  test("a clip reported with its source and transcript can be opened in the editor", async () => {
    const reported = await reportClip(file, { edit: firstEdit, transcript: words, signals: { energy: [0.1, 1], chat: [0, 4] }, source: { width: 1920, height: 1080, duration: 42, sha: sha256(source), size: source.length } });
    clip = reported.clip;
    assert.equal(reported.response.status, 200);
    assert.equal((await upload(clip.id, file)).status, 200);
    const opened = await (await edit(clip.id)).json();
    assert.deepEqual([opened.edit.trim, opened.words, opened.rev, opened.source.duration, opened.sourceStored], [{ start: 6, end: 36 }, words, 0, 42, false]);
    assert.equal((await dash()).body.clips.find(c => c.id === clip.id).editable, true);
    const old = (await reportClip(Buffer.alloc(3000, 9))).clip;
    assert.equal((await edit(old.id)).status, 409, "clips from older workers have nothing to edit");
    assert.equal((await fetch(base + "/api/clips/" + clip.id + "/edit")).status, 401);
  });
  test("an invalid edit in a report is refused", async () => {
    const bad = await reportClip(file, { edit: { ...firstEdit, trim: { start: 0, end: 2 } }, transcript: [], source: { width: 1, height: 1, duration: 42, sha: sha256(source), size: source.length } });
    assert.equal(bad.response.status, 400);
  });
  test("the source upload is checked and then playable by its owner only", async () => {
    const put = bytes => worker("/api/worker/clips/" + clip.id + "/source", { method: "PUT", headers: { "content-type": "video/mp4" }, body: bytes });
    assert.equal((await put(Buffer.alloc(9000, 6))).status, 422);
    assert.equal((await put(source)).status, 200);
    assert.deepEqual(await (await put(source)).json(), { ok: true, duplicate: true });
    const got = await fetch(base + "/api/clips/" + clip.id + "/source", { headers: { cookie } });
    assert.equal(got.status, 200);
    assert.deepEqual(Buffer.from(await got.arrayBuffer()), source);
    assert.equal((await fetch(base + "/api/clips/" + clip.id + "/source")).status, 401);
    assert.equal((await worker("/api/worker/clips/" + clip.id + "/source")).status, 200, "a worker can fetch it back to re-render");
    assert.equal((await edit(clip.id).then(r => r.json())).sourceStored, true);
  });
  test("saving an edit validates it, guards against stale saves and queues a render for the worker", async () => {
    const invalid = await save(clip.id, { edit: { ...firstEdit, captions: { ...firstEdit.captions, color: "red" } }, rev: 0 });
    assert.equal(invalid.status, 400);
    assert.match((await invalid.json()).error, /colour/);
    const changed = { ...firstEdit, trim: { start: 10, end: 30 }, hook: { ...firstEdit.hook, text: "watch this" }, words: [[6.2, 6.6, "Hi"], [6.7, 7.1, ""]] };
    const saved = await save(clip.id, { edit: changed, rev: 0, saveStyle: "streamer" });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).rev, 1);
    assert.equal((await save(clip.id, { edit: changed, rev: 0 })).status, 409, "a save based on an old version is refused");
    const row = (await dash()).body.clips.find(c => c.id === clip.id);
    assert.deepEqual([row.render_state, row.edit_rev], ["queued", 1]);
    const config = await (await worker("/api/worker/config")).json();
    const job = config.renders.find(r => r.id === clip.id);
    assert.deepEqual([job.rev, job.edit.trim, job.edit.hook.text, job.edit.words[1][2], job.source.width], [1, { start: 10, end: 30 }, "watch this", "", 1920]);
    assert.ok(config.streamers.find(s => s.id === streamer.id).style, "saveStyle stored the look for the streamer");
    await dash({ action: "style", streamerId: streamer.id, style: null });
  });
  test("the worker's render replaces the file only for the newest edit", async () => {
    const rendered = Buffer.alloc(6000, 8);
    assert.equal((await render(clip.id, rendered, 0)).status, 409, "old revision");
    assert.equal((await render(clip.id, rendered, 1, "f".repeat(64))).status, 422, "hash mismatch");
    assert.equal((await render(clip.id, rendered, 1)).status, 200);
    const row = (await dash()).body.clips.find(c => c.id === clip.id);
    assert.deepEqual([row.render_state, row.duration, row.size], [null, 20, rendered.length]);
    const got = await fetch(base + "/api/clips/" + clip.id + "/file", { headers: { cookie } });
    assert.deepEqual(Buffer.from(await got.arrayBuffer()), rendered);
    assert.equal((await render(clip.id, rendered, 1)).status, 409, "already rendered");
    assert.equal((await (await worker("/api/worker/config")).json()).renders.some(r => r.id === clip.id), false);
  });
  test("a failed render is shown and the previous file stays", async () => {
    assert.equal((await save(clip.id, { edit: firstEdit, rev: 1 })).status, 200);
    assert.equal((await worker("/api/worker/clips/" + clip.id + "/render", { method: "POST", body: JSON.stringify({ rev: 2, error: "ffmpeg failed (exit 1)" }) })).status, 200);
    const row = (await dash()).body.clips.find(c => c.id === clip.id);
    assert.deepEqual([row.render_state, row.render_error], ["failed", "ffmpeg failed (exit 1)"]);
    assert.equal((await fetch(base + "/api/clips/" + clip.id + "/file", { headers: { cookie } })).status, 200);
  });
  test("a clip from before the editor opens in limited mode, with its finished file as the source", async () => {
    const bytes = Buffer.alloc(7000, 3), old = (await reportClip(bytes, { duration: 22 })).clip;
    assert.equal((await upload(old.id, bytes)).status, 200);
    assert.equal((await dash()).body.clips.find(c => c.id === old.id).editable, true);
    const opened = await (await edit(old.id)).json();
    assert.deepEqual([opened.legacy, opened.sourceStored, opened.source.width, opened.source.height, opened.edit.captions.on, opened.edit.trim.end, opened.words], [true, true, 720, 1280, false, 22, []]);
    const src = await fetch(base + "/api/clips/" + old.id + "/source", { headers: { cookie } });
    assert.deepEqual(Buffer.from(await src.arrayBuffer()), bytes, "the source is a copy of the finished clip");
    assert.equal((await save(old.id, { edit: { ...opened.edit, trim: { start: 2, end: 20 } }, rev: 0 })).status, 200);
    assert.equal((await edit(old.id).then(r => r.json())).rev, 1, "opening it again keeps the edit");
    await dash({ action: "deleteClip", id: old.id });
  });
  test("a clip's post caption can be saved, cleared, and asks for a key before Claude can write one", async () => {
    const caption = body => fetch(base + "/api/clips/" + clip.id + "/caption", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
    let r = await caption({ action: "save", text: "  Watch till the end #clips  " });
    assert.deepEqual(await r.json().then(b => [b.text, b.source]), ["Watch till the end #clips", "edited"]);
    assert.equal((await edit(clip.id).then(x => x.json())).caption.text, "Watch till the end #clips");
    r = await caption({ action: "save", text: "" });
    assert.deepEqual(await r.json().then(b => [b.text, b.source]), [null, null]);
    if (!(await dash()).body.publishing.ai) {
      r = await caption({ action: "write" });
      assert.equal(r.status, 409);
      assert.match((await r.json()).error, /ANTHROPIC_API_KEY/);
    }
    assert.equal((await caption({ action: "save", text: "x".repeat(2201) })).status, 400);
    assert.equal((await fetch(base + "/api/clips/" + clip.id + "/caption", { method: "POST", body: "{}" })).status, 401);
  });
  test("AI caption settings are saved and kept when a client leaves them out", async () => {
    const { mode, duration, dailyLimit, captions, framing, destinations } = originalSettings;
    assert.equal((await dash({ action: "settings", settings: { mode, duration, dailyLimit, captions, framing, destinations, aiCaptions: false, captionNotes: "No emoji" } })).status, 200);
    let s = (await dash()).body.settings;
    assert.deepEqual([s.aiCaptions, s.captionNotes], [false, "No emoji"]);
    assert.equal((await dash({ action: "settings", settings: { mode, duration, dailyLimit, captions, framing, destinations } })).status, 200);
    s = (await dash()).body.settings;
    assert.deepEqual([s.aiCaptions, s.captionNotes], [false, "No emoji"], "unchanged");
    await dash({ action: "settings", settings: { mode, duration, dailyLimit, captions, framing, destinations, aiCaptions: true, captionNotes: "" } });
  });
  test("the transcribe setting is saved, kept when left out, and sent to the worker", async () => {
    const { mode, duration, dailyLimit, captions, framing, destinations } = originalSettings;
    assert.equal((await dash({ action: "settings", settings: { mode, duration, dailyLimit, captions, framing, destinations, transcribe: false } })).status, 200);
    assert.equal((await dash()).body.settings.transcribe, false);
    assert.equal((await (await worker("/api/worker/config")).json()).transcribe, false);
    assert.equal((await dash({ action: "settings", settings: { mode, duration, dailyLimit, captions, framing, destinations } })).status, 200);
    assert.equal((await dash()).body.settings.transcribe, false, "unchanged by a client that omits it");
    await dash({ action: "settings", settings: { mode, duration, dailyLimit, captions, framing, destinations, transcribe: true } });
    assert.equal((await (await worker("/api/worker/config")).json()).transcribe, true);
  });
  test("subtitles can be removed from (and added back to) every recorded clip at once", async () => {
    const before = (await dash()).body.clips.find(c => c.id === clip.id).edit_rev;
    // Start from a known state: subtitles on in this clip's edit.
    const on = await dash({ action: "captionsAll", on: true });
    assert.equal(on.status, 200);
    const off = await dash({ action: "captionsAll", on: false });
    assert.equal(off.status, 200);
    assert.match(off.body.message, /^Removing subtitles from \d+ clips?\./);
    const row = (await dash()).body.clips.find(c => c.id === clip.id);
    assert.equal(row.render_state, "queued");
    assert.ok(row.edit_rev > before, "a new revision to render");
    const job = (await (await worker("/api/worker/config")).json()).renders.find(r => r.id === clip.id);
    assert.equal(job.edit.captions.on, false, "the worker re-renders it without subtitles");
    assert.equal(job.edit.trim.start, (await edit(clip.id).then(r => r.json())).edit.trim.start, "the rest of the edit is kept");
    assert.match((await dash({ action: "captionsAll", on: false })).body.message, /^No clips to change/, "running it again changes nothing");
    const back = await dash({ action: "captionsAll", on: true });
    assert.match(back.body.message, /^Adding subtitles to \d+ clips?\./);
    assert.equal((await (await worker("/api/worker/config")).json()).renders.find(r => r.id === clip.id).edit.captions.on, true);
    assert.equal((await dash({ action: "captionsAll", on: "yes" })).status, 400);
  });
  test("selected clips can be accepted, rejected and sent back to review together", async () => {
    const bulk = body => dash({ action: "bulkClips", ...body });
    const other = (await reportClip(Buffer.alloc(3000, 2))).clip;
    let r = await bulk({ ids: [clip.id, other.id], op: "reject" });
    assert.equal(r.status, 200);
    let rows = (await dash()).body.clips.filter(c => c.id === clip.id || c.id === other.id);
    assert.deepEqual(rows.map(c => c.review), ["rejected", "rejected"]);
    r = await bulk({ ids: [clip.id, other.id], op: "pending" });
    assert.match(r.body.message, /^Moved back to review: 2 clips\.$/);
    r = await bulk({ ids: [clip.id, other.id], op: "approve" });
    assert.equal(r.body.message, "Approved 2 clips.");
    assert.equal((await bulk({ ids: [clip.id, other.id], op: "approve" })).body.message, "Approved 0 clips.", "already approved");
    await dash({ action: "deleteClip", id: other.id });
  });
  test("selected clips can be reframed or have subtitles changed, even more than 100 at once", async () => {
    const bulk = body => dash({ action: "bulkClips", ...body });
    const many = [clip.id, ...Array.from({ length: 149 }, () => randomUUID())];
    let r = await bulk({ ids: many, op: "frame", frame: "crop" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.match(r.body.message, /^Reframing \(crop\) 1 clip\..*149 clips left as they were/);
    let job = (await (await worker("/api/worker/config")).json()).renders.find(x => x.id === clip.id);
    assert.equal(job.edit.frame.mode, "crop");
    r = await bulk({ ids: [clip.id], op: "captionsOff" });
    job = (await (await worker("/api/worker/config")).json()).renders.find(x => x.id === clip.id);
    assert.deepEqual([job.edit.frame.mode, job.edit.captions.on], ["crop", false], "edits add up");
    assert.equal((await bulk({ ids: [clip.id], op: "frame" })).status, 400, "framing needs a choice");
    assert.equal((await bulk({ ids: [clip.id], op: "explode" })).status, 400);
    assert.equal((await bulk({ ids: [], op: "approve" })).status, 400);
  });
  test("selected clips can be deleted together, with their stored files", async () => {
    const a = (await reportClip(Buffer.alloc(3000, 7))).clip, b = (await reportClip(Buffer.alloc(3000, 8))).clip;
    assert.equal((await upload(a.id, Buffer.alloc(3000, 7))).status, 200);
    const r = await dash({ action: "bulkClips", ids: [a.id, b.id, randomUUID()], op: "delete" });
    assert.equal(r.body.message, "Deleted 2 clips.");
    const ids = (await dash()).body.clips.map(c => c.id);
    assert.ok(!ids.includes(a.id) && !ids.includes(b.id));
    assert.equal((await fetch(base + "/api/clips/" + a.id + "/file", { headers: { cookie } })).status, 404);
  });
  test("deleting a clip also removes its source", async () => {
    assert.equal((await dash({ action: "deleteClip", id: clip.id })).status, 200);
    assert.equal((await worker("/api/worker/clips/" + clip.id + "/source")).status, 404);
  });
});

describe("editing a streamer", () => {
  test("name, channel, clipping and accounts can be changed; bad or duplicate channels are refused", async () => {
    const name = "edit" + Date.now().toString(36);
    assert.equal((await dash({ action: "add", url: "https://twitch.tv/" + name })).status, 200);
    const s = (await dash()).body.streamers.find(x => x.url === "https://twitch.tv/" + name);
    await worker("/api/worker/status", { method: "POST", body: JSON.stringify({ streamers: [{ id: s.id, status: "offline", checkedAt: new Date().toISOString(), title: null }] }) });
    const edit = body => dash({ action: "editStreamer", id: s.id, name: "Renamed", url: s.url, ...body });
    let r = await edit({});
    assert.equal(r.status, 200);
    assert.match(r.body.message, /renamed to Renamed/);
    r = await edit({ url: "https://kick.com/" + name, status: "paused", accounts: [] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const now = (await dash()).body.streamers.find(x => x.id === s.id);
    assert.deepEqual([now.name, now.url, now.platform, now.status, now.live_status, now.accounts], ["Renamed", "https://kick.com/" + name, "Kick", "paused", null, []], "a new channel starts with a fresh live status");
    assert.equal((await edit({ url: "https://twitch.tv/directory" })).status, 400);
    assert.equal((await edit({ url: streamer.url })).status, 409, "another streamer already has that channel");
    assert.equal((await dash({ action: "editStreamer", id: randomUUID(), name: "x", url: s.url })).status, 404);
    assert.equal((await edit({ name: "" })).status, 400);
    await dash({ action: "remove", id: s.id });
  });
});

describe("split-screen backgrounds", () => {
  const up = (bytes, type = "video/mp4", name = "Parkour run.mp4") => fetch(base + "/api/backgrounds", { method: "POST", headers: { cookie, "content-type": type, "x-file-name": encodeURIComponent(name) }, body: bytes });
  let bg;
  test("a background video can be uploaded, previewed by its owner and downloaded by the worker", async () => {
    const bytes = Buffer.alloc(5000, 3);
    assert.equal((await up(bytes, "image/png")).status, 415, "MP4 only");
    assert.equal((await up(Buffer.alloc(10))).status, 400, "empty");
    const r = await up(bytes);
    assert.equal(r.status, 200, await r.clone().text());
    const body = await r.json();
    bg = body.backgrounds.find(b => b.name === "Parkour run");
    assert.ok(bg, "listed under its name, without the extension");
    assert.equal(bg.size, 5000);
    assert.equal((await dash()).body.backgrounds.some(b => b.id === bg.id), true);
    const own = await fetch(base + "/api/backgrounds/" + bg.id + "/file", { headers: { cookie } });
    assert.deepEqual(Buffer.from(await own.arrayBuffer()), bytes);
    assert.equal((await fetch(base + "/api/backgrounds/" + bg.id + "/file")).status, 401);
    const config = await (await worker("/api/worker/config")).json();
    assert.ok(config.backgrounds.some(b => b.id === bg.id && b.size === 5000), "the worker is told about it");
    const got = await worker("/api/worker/backgrounds/" + bg.id);
    assert.deepEqual(Buffer.from(await got.arrayBuffer()), bytes);
    assert.equal((await fetch(base + "/api/worker/backgrounds/" + bg.id)).status, 401);
  });
  test("split screen can be the default framing and is applied to selected clips with captions on the seam", async () => {
    const { mode, duration, dailyLimit, captions, destinations } = originalSettings;
    assert.equal((await dash({ action: "settings", settings: { mode, duration, dailyLimit, captions, framing: "split", destinations } })).status, 200);
    assert.equal((await (await worker("/api/worker/config")).json()).framing, "split");
    await dash({ action: "settings", settings: { mode, duration, dailyLimit, captions, framing: originalSettings.framing ?? "blur", destinations } });
    const source = Buffer.alloc(9000, 5), file = Buffer.alloc(5000, 4);
    const edit = defaultEdit(defaultStyle(), { trimStart: 6, trimEnd: 36 });
    const { clip } = await reportClip(file, { edit, transcript: [], source: { width: 1920, height: 1080, duration: 42, sha: sha256(source), size: source.length } });
    await worker("/api/worker/clips/" + clip.id + "/source", { method: "PUT", headers: { "content-type": "video/mp4" }, body: source });
    const r = await dash({ action: "bulkClips", ids: [clip.id], op: "frame", frame: "split" });
    assert.match(r.body.message, /^Reframing \(split\) 1 clip/);
    const job = (await (await worker("/api/worker/config")).json()).renders.find(x => x.id === clip.id);
    assert.deepEqual([job.edit.frame.mode, job.edit.captions.y], ["split", 0.5]);
    await dash({ action: "deleteClip", id: clip.id });
  });
  test("background lengths are recorded, and other clips are offered with theirs", async () => {
    const timed = await fetch(base + "/api/backgrounds", { method: "POST", headers: { cookie, "content-type": "video/mp4", "x-file-name": "Long%20loop.mp4", "x-duration": "62.345" }, body: Buffer.alloc(4000, 1) });
    const long = (await timed.json()).backgrounds.find(b => b.name === "Long loop");
    assert.equal(long.duration, 62.35);
    // A video uploaded before lengths were recorded gets one from Settings, once.
    assert.equal(bg.duration ?? null, null);
    assert.equal((await dash({ action: "backgroundLength", id: bg.id, duration: 30 })).status, 200);
    assert.equal((await dash({ action: "backgroundLength", id: bg.id, duration: 99 })).status, 200);
    const config = await (await worker("/api/worker/config")).json();
    assert.equal(config.backgrounds.find(b => b.id === bg.id).duration, 30, "an existing length isn't overwritten");
    // Clips that can play underneath another one: those with a stored source, never the clip itself.
    const source = Buffer.alloc(9000, 5), edit = defaultEdit(defaultStyle(), { trimStart: 6, trimEnd: 36 });
    const make = async () => { const { clip } = await reportClip(Buffer.alloc(5000, 4), { edit, transcript: [], source: { width: 1920, height: 1080, duration: 42, sha: sha256(source), size: source.length } }); await worker("/api/worker/clips/" + clip.id + "/source", { method: "PUT", headers: { "content-type": "video/mp4" }, body: source }); return clip; };
    const a = await make(), b = await make();
    const offered = await (await fetch(base + "/api/backgrounds?for=" + a.id, { headers: { cookie } })).json();
    assert.ok(offered.clips.some(c => c.id === b.id && c.duration === 42), "the other clip, by its source length");
    assert.ok(!offered.clips.some(c => c.id === a.id), "not itself");
    assert.equal((await fetch(base + "/api/backgrounds", { headers: { cookie } }).then(r => r.json())).clips, undefined, "only when asked");
    await dash({ action: "bulkClips", ids: [a.id, b.id], op: "delete" });
    await dash({ action: "deleteBackground", id: long.id });
  });
  test("deleting a background removes it everywhere", async () => {
    assert.equal((await dash({ action: "deleteBackground", id: bg.id })).status, 200);
    assert.equal((await dash()).body.backgrounds.some(b => b.id === bg.id), false);
    assert.equal((await worker("/api/worker/backgrounds/" + bg.id)).status, 404);
    assert.equal((await dash({ action: "deleteBackground", id: bg.id })).status, 404);
  });
});

describe("recordings", () => {
  const rec = () => ({ op: "recording", id: randomUUID(), streamerId: streamer.id, startedAt: new Date().toISOString(), state: "recording", title: "Finals" });
  const post = body => worker("/api/worker/recordings", { method: "POST", body: JSON.stringify(body) });
  test("a streamer's capture mode is saved and sent to the worker", async () => {
    const s = (await dash()).body.streamers.find(x => x.id === streamer.id);
    assert.equal((await dash({ action: "editStreamer", id: streamer.id, name: s.name, url: s.url, captureMode: "record" })).status, 200);
    const config = await (await worker("/api/worker/config")).json();
    assert.equal(config.streamers.find(x => x.id === streamer.id).captureMode, "record");
    assert.equal(typeof config.recordingDays, "number");
    assert.ok(Array.isArray(config.recordings) && Array.isArray(config.clipRequests));
    assert.equal((await dash({ action: "editStreamer", id: streamer.id, name: s.name, url: s.url, captureMode: "archive" })).status, 400);
  });
  test("a recording is reported, clipped on request, previewed and deleted", async () => {
    const r = rec();
    assert.equal((await post(r)).status, 200);
    let row = (await dash()).body.recordings.find(x => x.id === r.id);
    assert.deepEqual([row.state, row.title, row.preview], ["recording", "Finals", false]);
    assert.equal((await dash({ action: "deleteRecording", id: r.id })).status, 409, "a recording in progress can't be deleted");
    // The same report again (a worker retry) is an update, not a second recording.
    assert.equal((await post({ ...r, state: "ready", endedAt: new Date().toISOString(), duration: 3600, size: 2e9, signals: { step: 2, energy: [0, 0.5, 1], chat: [0, 3, 9] } })).status, 200);
    const mine = (await dash()).body.recordings.filter(x => x.id === r.id);
    assert.equal(mine.length, 1);
    assert.deepEqual([mine[0].state, mine[0].duration], ["ready", 3600]);
    assert.deepEqual((await (await fetch(base + "/api/recordings/" + r.id, { headers: { cookie } })).json()).signals.chat, [0, 3, 9]);
    // Clips are 15 to 90 seconds.
    assert.equal((await dash({ action: "makeClip", recordingId: r.id, start: 100, end: 105 })).status, 400);
    assert.equal((await dash({ action: "makeClip", recordingId: r.id, start: 100, end: 130 })).status, 200);
    assert.equal((await dash({ action: "findMoments", recordingId: r.id, count: 3 })).status, 200);
    const config = await (await worker("/api/worker/config")).json();
    assert.ok(config.recordings.includes(r.id));
    const asks = config.clipRequests.filter(q => q.recordingId === r.id);
    assert.deepEqual(asks.map(q => q.kind).sort(), ["best", "moment"]);
    const moment = asks.find(q => q.kind === "moment");
    assert.deepEqual([moment.start, moment.end], [100, 130]);
    assert.equal((await post({ op: "request", id: moment.id, state: "working" })).status, 200);
    assert.equal((await post({ op: "request", id: moment.id, state: "done", clips: 1 })).status, 200);
    const done = (await dash()).body.recordingRequests.find(q => q.id === moment.id);
    assert.deepEqual([done.state, done.clips], ["done", 1]);
    assert.ok(!(await (await worker("/api/worker/config")).json()).clipRequests.some(q => q.id === moment.id), "finished requests aren't sent again");
    // A clip cut from it reports as "manual".
    const bytes = Buffer.alloc(4096, 7);
    assert.equal((await reportClip(bytes, { reason: "manual" })).response.status, 200);
    // The preview arrives in parts; parts out of order are refused.
    const part1 = Buffer.alloc(5 * 1024 * 1024, 1), part2 = Buffer.alloc(1000, 2), path = "/api/worker/recordings/" + r.id + "/preview";
    const put = (n, body) => worker(path, { method: "PUT", headers: { "content-type": "application/octet-stream", "x-part": String(n), "x-parts": "2" }, body });
    assert.equal((await put(2, part2)).status, 409);
    assert.equal((await put(1, part1)).status, 200);
    assert.equal((await put(2, part2)).status, 200);
    assert.equal((await worker(path, { method: "POST", body: JSON.stringify({ parts: 2, size: part1.length + part2.length }) })).status, 200);
    row = (await dash()).body.recordings.find(x => x.id === r.id);
    assert.equal(row.preview, true);
    const ranged = await fetch(base + "/api/recordings/" + r.id + "/preview", { headers: { cookie, range: "bytes=" + (part1.length - 2) + "-" + (part1.length + 1) } });
    assert.equal(ranged.status, 206);
    assert.deepEqual([...new Uint8Array(await ranged.arrayBuffer())], [1, 1, 2, 2]);
    assert.equal((await fetch(base + "/api/recordings/" + r.id + "/preview")).status, 401);
    // Deleting it removes the preview and its requests; the worker sees it gone.
    assert.equal((await dash({ action: "deleteRecording", id: r.id })).status, 200);
    assert.ok(!(await dash()).body.recordings.some(x => x.id === r.id));
    assert.equal((await fetch(base + "/api/recordings/" + r.id + "/preview", { headers: { cookie } })).status, 404);
    assert.ok(!(await (await worker("/api/worker/config")).json()).recordings.includes(r.id));
  });
  test("recording reports are checked", async () => {
    assert.equal((await fetch(base + "/api/worker/recordings", { method: "POST", body: "{}" })).status, 401);
    assert.equal((await post({ ...rec(), state: "archived" })).status, 400);
    assert.equal((await post({ ...rec(), streamerId: randomUUID() })).status, 404);
    assert.equal((await dash({ action: "makeClip", recordingId: randomUUID(), start: 0, end: 30 })).status, 404);
  });
});
