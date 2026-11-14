// End-to-end test of Instagram publishing against the real built Worker (wrangler dev, local D1 and R2) and a
// fake Instagram. Run after `npm run build` and applying migrations locally:  npm run test:publishing
// It signs in with Sites-style identity headers (the default AUTH_MODE), so it never touches production.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { startFakeInstagram } from "./fake-instagram.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const port = 8790 + Math.floor(Math.random() * 100), base = "http://127.0.0.1:" + port;
const owner = "pubtest_" + Date.now().toString(36);
const who = { "oai-authenticated-user-id": owner, "oai-authenticated-user-email": owner + "@test.local" };
let fake, dev, workerToken, streamer;
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
async function addClip(streamerId = streamer.id) {
  const bytes = randomBytes(6000), clip = { id: randomUUID(), streamerId, createdAt: new Date().toISOString(), duration: 30, captions: true, sha: createHash("sha256").update(bytes).digest("hex"), size: bytes.length, reason: "chat" };
  assert.equal((await worker("/api/worker/clips", { method: "POST", body: JSON.stringify(clip) })).status, 200);
  assert.equal((await worker("/api/worker/clips/" + clip.id + "/file", { method: "PUT", headers: { "content-type": "video/mp4" }, body: bytes })).status, 200);
  return { clip, bytes };
}
const posts = async () => (await dash()).body.posts;

before(async () => {
  fake = await startFakeInstagram();
  const graph = "http://127.0.0.1:" + fake.port;
  const vars = { ENABLE_TEST_CRON: "1", INSTAGRAM_APP_ID: "test-app", INSTAGRAM_APP_SECRET: "test-secret", TOKEN_KEY: randomBytes(32).toString("base64"), MEDIA_KEY: randomBytes(32).toString("base64"), PUBLIC_URL: base, INSTAGRAM_AUTH_URL: graph, INSTAGRAM_API_URL: graph, INSTAGRAM_GRAPH_URL: graph };
  dev = spawn(process.execPath, ["--import", "./scripts/sites-env.mjs", "./node_modules/wrangler/bin/wrangler.js", "dev", "--config", "dist/server/wrangler.json", "--local", "--persist-to", ".wrangler/state", "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", "0", ...Object.entries(vars).flatMap(([k, v]) => ["--var", k + ":" + v])], { cwd: root, stdio: "ignore", env: { ...process.env, CI: "true" } });
  for (let i = 0; i < 90; i++) { try { await fetch(base + "/api/worker/config"); break; } catch { await sleep(1000); } }
  assert.equal((await dash({ action: "settings", settings: { mode: "automatic", duration: 30, dailyLimit: 2, captions: true, framing: "blur", destinations: ["Instagram"], captionTemplate: "{streamer} on {platform} #test" } })).status, 200);
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
  } finally { dev?.kill(); fake?.server.close(); }
});

test("dashboard reports Instagram publishing as available", async () => {
  assert.deepEqual((await dash()).body.publishing, { instagram: true, zernio: false });
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
