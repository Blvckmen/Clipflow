// End-to-end test of Instagram publishing against the real built Worker (wrangler dev, local D1 and R2) and a
// fake Instagram. Run after `npm run build` and applying migrations locally:  npm run test:publishing
// It signs in with Sites-style identity headers (the default AUTH_MODE), so it never touches production.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, openSync } from "node:fs";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { startFakeInstagram } from "./fake-instagram.mjs";
import { startFakeAnthropic } from "./fake-anthropic.mjs";
import { defaultEdit, defaultStyle } from "../worker/edit.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const port = 8790 + Math.floor(Math.random() * 100), base = "http://127.0.0.1:" + port;
const owner = "pubtest_" + Date.now().toString(36);
const who = { "oai-authenticated-user-id": owner, "oai-authenticated-user-email": owner + "@test.local" };
let fake, claude, dev, workerToken, streamer;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dash = async body => {
  const r = await fetch(base + "/api/dashboard", body ? { method: "POST", headers: { ...who, "content-type": "application/json" }, body: JSON.stringify(body) } : { headers: who });
  return { status: r.status, body: await r.json() };
};
const worker = (path, init = {}) => fetch(base + path, { ...init, headers: { authorization: "Bearer " + workerToken, "content-type": "application/json", ...init.headers } });
let clock = Date.now();
// Fire the Worker's cron handler as if it ran at `clock`, then let its waitUntil work finish.
async function cron(advanceMs = 0) {
  clock += advanceMs;
  const r = await fetch(base + "/__test/cron?time=" + clock);
  assert.equal(r.status, 200, "publisher run failed: " + (await r.text()).slice(0, 600));
}
const fakeLog = async () => (await fetch("http://127.0.0.1:" + fake.port + "/__log")).json();
async function addClip(streamerId = streamer.id, extra = {}) {
  const bytes = randomBytes(6000), clip = { id: randomUUID(), streamerId, createdAt: new Date().toISOString(), duration: 30, captions: true, sha: createHash("sha256").update(bytes).digest("hex"), size: bytes.length, reason: "chat", ...extra };
  assert.equal((await worker("/api/worker/clips", { method: "POST", body: JSON.stringify(clip) })).status, 200);
  assert.equal((await worker("/api/worker/clips/" + clip.id + "/file", { method: "PUT", headers: { "content-type": "video/mp4" }, body: bytes })).status, 200);
  return { clip, bytes };
}
const posts = async () => (await dash()).body.posts;

before(async () => {
  fake = await startFakeInstagram();
  claude = await startFakeAnthropic();
  const graph = "http://127.0.0.1:" + fake.port;
  const vars = { ENABLE_TEST_CRON: "1", ANTHROPIC_API_KEY: "test-anthropic-key", ANTHROPIC_BASE_URL: "http://127.0.0.1:" + claude.port, INSTAGRAM_APP_ID: "test-app", INSTAGRAM_APP_SECRET: "test-secret", TOKEN_KEY: randomBytes(32).toString("base64"), MEDIA_KEY: randomBytes(32).toString("base64"), PUBLIC_URL: base, INSTAGRAM_AUTH_URL: graph, INSTAGRAM_API_URL: graph, INSTAGRAM_GRAPH_URL: graph };
  dev = spawn(process.execPath, ["--import", "./scripts/sites-env.mjs", "./node_modules/wrangler/bin/wrangler.js", "dev", "--config", "dist/server/wrangler.json", "--local", "--persist-to", ".wrangler/state", "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", "0", ...Object.entries(vars).flatMap(([k, v]) => ["--var", k + ":" + v])], { cwd: root, stdio: process.env.E2E_DEV_LOG ? ["ignore", openSync(process.env.E2E_DEV_LOG, "w"), "pipe"] : "ignore", env: { ...process.env, CI: "true" } });
  // E2E_DEV_LOG=<file> keeps the Worker's own log (console.error from the publisher and the caption writer).
  if (process.env.E2E_DEV_LOG) dev.stderr.on("data", d => appendFileSync(process.env.E2E_DEV_LOG, d));
  for (let i = 0; i < 90; i++) { try { await fetch(base + "/api/worker/config"); break; } catch { await sleep(1000); } }
  assert.equal((await dash({ action: "settings", settings: { mode: "automatic", duration: 30, dailyLimit: 2, captions: true, framing: "blur", destinations: ["Instagram"], captionTemplate: "{streamer} on {platform} #test", aiCaptions: false } })).status, 200);
  assert.equal((await dash({ action: "control", control: "running" })).status, 200);
  assert.equal((await dash({ action: "add", url: "https://twitch.tv/" + owner })).status, 200);
  streamer = (await dash()).body.streamers[0];
  workerToken = (await dash({ action: "token" })).body.token;
});

after(async () => {
  try {
    const { body } = await dash();
    for (const c of body.clips ?? []) await dash({ action: "deleteClip", id: c.id });
    for (const a of body.accounts ?? []) await dash({ action: "disconnect", id: a.id });
    for (const s of body.streamers ?? []) await dash({ action: "remove", id: s.id });
    await dash({ action: "control", control: "paused" });
  } finally { dev?.kill(); fake?.server.close(); claude?.server.close(); }
});

test("dashboard reports Instagram publishing as available", async () => {
  const { publishing } = (await dash()).body;
  assert.deepEqual({ instagram: publishing.instagram, zernio: publishing.zernio, ai: publishing.ai }, { instagram: true, zernio: false, ai: true });
});

test("connecting Instagram stores an encrypted token and never exposes it", async () => {
  const start = await fetch(base + "/api/connections/instagram/start", { headers: who, redirect: "manual" });
  assert.equal(start.status, 302);
  const cookie = start.headers.get("set-cookie").split(";")[0];
  assert.match(cookie, /^ig_oauth_state=/);
  const authorize = await fetch(start.headers.get("location"), { redirect: "manual" });
  const callback = authorize.headers.get("location");
  assert.match(callback, /\/api\/connections\/instagram\/callback\?code=fake-code-\d+&state=.*#_$/);
  // A callback without the browser's state cookie is refused (CSRF protection).
  const forged = await fetch(callback.replace("#_", ""), { headers: who, redirect: "manual" });
  assert.match(forged.headers.get("location"), /connect_error=/);
  const done = await fetch(callback.replace("#_", ""), { headers: { ...who, cookie }, redirect: "manual" });
  assert.match(done.headers.get("location"), /\?connected=instagram&account=clipflow_test$/);
  const { body } = await dash();
  assert.deepEqual(body.accounts.map(a => [a.platform, a.username, a.status]), [["instagram", "clipflow_test", "connected"]]);
  assert.deepEqual(body.streamers[0].accounts, [body.accounts[0].id], "the first account posts for every existing streamer");
  assert.ok(!JSON.stringify(body).includes("long-"), "no token in dashboard data");
});

test("an approved clip is posted once: container, processing, publish, permalink", async () => {
  const { clip, bytes } = await addClip();
  await cron();
  let [post] = await posts();
  assert.equal(post.state, "processing", post.error ?? "");
  const { containers } = await fakeLog();
  const [, container] = containers.at(-1);
  assert.equal(container.fetchStatus, 200, "Instagram could download the signed link");
  assert.equal(container.bytes, bytes.length);
  assert.equal(container.contentType, "video/mp4");
  assert.equal(container.caption, owner + " on Twitch #test");
  assert.match(container.videoUrl, new RegExp("^" + base + "/media/" + clip.id + "\\.mp4\\?e=\\d+&s="));
  await cron(30_000);  // too soon: not checked yet
  await cron(40_000);  // first check: still IN_PROGRESS
  [post] = await posts();
  assert.equal(post.state, "processing");
  await cron(61_000);  // second check: FINISHED -> publish
  [post] = await posts();
  assert.equal(post.state, "published", post.error ?? "");
  assert.match(post.permalink, /^https:\/\/www\.instagram\.com\/reel\/m-\d+\/$/);
  const publishCalls = (await fakeLog()).log.filter(e => e.path.endsWith("/media_publish")).length;
  await cron(120_000); await cron(120_000);
  assert.equal((await fakeLog()).log.filter(e => e.path.endsWith("/media_publish")).length, publishCalls, "never published twice");
  assert.equal((await posts()).length, 1);
});

test("signed media links refuse missing, altered or foreign signatures", async () => {
  const url = new URL((await fakeLog()).containers.at(-1)[1].videoUrl);
  assert.equal((await fetch(base + url.pathname)).status, 404);
  assert.equal((await fetch(base + url.pathname + "?e=" + url.searchParams.get("e") + "&s=AAAA" + url.searchParams.get("s").slice(4))).status, 404);
  assert.equal((await fetch(base + "/media/" + randomUUID() + ".mp4" + url.search)).status, 404, "signature belongs to another clip");
  assert.equal((await fetch(base + url.pathname + url.search, { headers: { range: "bytes=0-99" } })).status, 206, "valid link supports ranges");
});

test("rejected clips are not posted and pausing stops publishing", async () => {
  const { clip } = await addClip();
  assert.equal((await dash({ action: "reviewClip", id: clip.id, review: "rejected" })).status, 200);
  await dash({ action: "control", control: "paused" });
  const second = await addClip();
  await cron(120_000);
  assert.equal((await posts()).length, 1, "nothing queued while paused, rejected clip never");
  await dash({ action: "control", control: "running" });
  await cron(120_000);
  const queued = (await posts()).find(p => p.clip_id === second.clip.id);
  assert.ok(queued, "resumed: the approved clip is queued");
});

test("several accounts: each streamer posts only to the accounts linked to it", async () => {
  assert.equal((await dash({ action: "add", url: "https://kick.com/" + owner + "b" })).status, 200);
  const second = (await dash()).body.streamers.find(s => s.url === "https://kick.com/" + owner + "b");
  assert.deepEqual(second.accounts, [], "added without picking an account: library only");
  // Connect a second Instagram account, started from the second streamer.
  await fetch("http://127.0.0.1:" + fake.port + "/__signin?id=17890001&username=second_test", { method: "POST" });
  const start = await fetch(base + "/api/connections/instagram/start?streamer=" + second.id + "&another=1", { headers: who, redirect: "manual" });
  assert.equal(new URL(start.headers.get("location")).searchParams.get("force_reauth"), "true", "Instagram is asked which account to use");
  const cookie = start.headers.get("set-cookie").split(";")[0];
  const authorize = await fetch(start.headers.get("location"), { redirect: "manual" });
  const done = await fetch(authorize.headers.get("location").replace("#_", ""), { headers: { ...who, cookie }, redirect: "manual" });
  assert.match(done.headers.get("location"), /connected=instagram&account=second_test$/);
  let { body } = await dash();
  const first = body.accounts.find(a => a.username === "clipflow_test"), other = body.accounts.find(a => a.username === "second_test");
  assert.equal(body.accounts.length, 2);
  assert.deepEqual(body.streamers.find(s => s.id === second.id).accounts, [other.id], "linked to the streamer it was started from");
  assert.deepEqual(body.streamers.find(s => s.id === streamer.id).accounts, [first.id], "the first streamer keeps its account");

  const { clip } = await addClip(second.id);
  await cron(120_000);
  assert.deepEqual((await posts()).filter(p => p.clip_id === clip.id).map(p => p.account), ["second_test"]);
  const { containers } = await fakeLog();
  assert.equal(containers.at(-1)[1].user, "17890001", "uploaded with the second account's own token");

  assert.equal((await dash({ action: "assign", streamerId: streamer.id, accounts: [first.id, other.id] })).status, 200);
  assert.equal((await dash({ action: "assign", streamerId: streamer.id, accounts: [randomUUID()] })).status, 404, "only your own accounts");
  const both = await addClip();
  await cron(120_000);
  assert.deepEqual((await posts()).filter(p => p.clip_id === both.clip.id).map(p => p.account).sort(), ["clipflow_test", "second_test"]);
  ({ body } = await dash());
  assert.deepEqual(body.streamers.find(s => s.id === streamer.id).accounts.sort(), [first.id, other.id].sort());
});

test("Claude writes post captions from the transcript ahead of posting; the owner's own text wins", async () => {
  const settings = { mode: "automatic", duration: 30, dailyLimit: 50, captions: true, framing: "blur", destinations: [], aiCaptions: true, captionNotes: "Always add #fyp" };
  assert.equal((await dash({ action: "settings", settings })).status, 200);
  const words = [[6.2, 6.6, "No"], [6.7, 7.0, "way"], [7.1, 7.5, "he"], [7.6, 8.0, "clutched"], [8.1, 8.6, "that!"], [40, 41, "outside"]];
  const material = () => { const src = randomBytes(2048); return { edit: defaultEdit(defaultStyle(), { trimStart: 6, trimEnd: 36 }), transcript: words, source: { width: 1920, height: 1080, duration: 42, sha: createHash("sha256").update(src).digest("hex"), size: src.length } }; };
  const clipRow = async id => (await dash()).body.clips.find(c => c.id === id);
  const postedCaption = async id => {
    for (let i = 0; i < 12; i++) {
      const found = (await fakeLog()).containers.find(([, c]) => c.videoUrl.includes(id));
      if (found) return found[1].caption;
      await cron(120_000);
    }
    return null;
  };

  // 1. Written in advance from the clip's own transcript (only the part inside the trim), with the owner's guidance.
  const first = await addClip(streamer.id, material());
  await cron(1000);
  // Earlier test clips without a caption get one in the same pass; find this clip's request by its transcript.
  const request = claude.log.find(r => r.text.includes("clutched"));
  assert.ok(request, "Claude was asked for this clip's caption: " + JSON.stringify({ requests: claude.log.length, caption: (await (await fetch(base + "/api/clips/" + first.clip.id + "/edit", { headers: who })).json()).caption }));
  assert.deepEqual([request.model, request.effort, request.format, request.fallbacks], ["claude-opus-5-5", "low", "json_schema", "default"]);
  assert.match(request.beta, /server-side-fallback-2026-07-01/);
  assert.match(request.text, /<transcript>No way he clutched that!<\/transcript>/);
  assert.doesNotMatch(request.text, /outside/, "words outside the trim are left out");
  assert.match(request.text, /<guidance>Always add #fyp<\/guidance>/);
  const written = await clipRow(first.clip.id);
  assert.equal(written.caption_source, "ai");
  assert.equal(written.post_caption, owner + " did NOT see that coming\n\n\"No way he clutched that!…\"\n\n#" + owner + " #clips #fyp");
  assert.equal(await postedCaption(first.clip.id), written.post_caption, "the written caption is what posts");

  // 2. Text the owner saves is used as-is and never rewritten.
  const second = await addClip(streamer.id, material());
  const saved = await fetch(base + "/api/clips/" + second.clip.id + "/caption", { method: "POST", headers: { ...who, "content-type": "application/json" }, body: JSON.stringify({ action: "save", text: "My own words #mine" }) });
  assert.equal(saved.status, 200);
  assert.equal(await postedCaption(second.clip.id), "My own words #mine");
  const kept = await clipRow(second.clip.id);
  assert.deepEqual([kept.post_caption, kept.caption_source], ["My own words #mine", "edited"], "Claude never wrote over it");

  // 3. Rewrite on request replaces it.
  const rewrite = await fetch(base + "/api/clips/" + second.clip.id + "/caption", { method: "POST", headers: { ...who, "content-type": "application/json" }, body: JSON.stringify({ action: "write" }) });
  assert.equal(rewrite.status, 200);
  assert.equal((await rewrite.json()).source, "ai");

  // 4. If Claude declines, the post goes out with the template instead of waiting forever.
  await fetch("http://127.0.0.1:" + claude.port + "/__refuse?on=1", { method: "POST" });
  await dash({ action: "settings", settings: { ...settings, captionTemplate: "{streamer} fallback #test" } });
  const third = await addClip(streamer.id, material());
  assert.equal(await postedCaption(third.clip.id), owner + " fallback #test");
  const failed = await clipRow(third.clip.id);
  assert.equal(failed.post_caption, null);
  await fetch("http://127.0.0.1:" + claude.port + "/__refuse?on=0", { method: "POST" });
  const refused = await fetch(base + "/api/clips/" + third.clip.id + "/edit", { headers: who });
  assert.match((await refused.json()).caption.error, /declined/);
});

test("a revoked Instagram token marks the account for reconnection without losing the post", async () => {
  await fetch("http://127.0.0.1:" + fake.port + "/__revoke", { method: "POST" });
  await cron(600_000); await cron(120_000);
  const { body } = await dash();
  // An account learns its token is gone the next time it calls Instagram, i.e. when it has something to post.
  const expired = body.accounts.filter(a => a.status === "expired");
  assert.ok(expired.length >= 1, "an account with work waiting is marked for reconnection");
  for (const account of expired) assert.match(account.last_error, /reconnect/i);
  assert.ok(body.posts.some(p => expired.some(a => a.id === p.account_id) && (p.state === "queued" || p.state === "processing")), "its post is kept for after reconnecting");
});

test("disconnecting removes the account and its links, and drops unsent posts", async () => {
  for (const a of (await dash()).body.accounts) assert.equal((await dash({ action: "disconnect", id: a.id })).status, 200);
  const { body } = await dash();
  assert.equal(body.accounts.length, 0);
  assert.ok(body.streamers.every(s => s.accounts.length === 0));
  assert.ok(body.posts.every(p => p.state === "published"), "only published history is kept");
});
