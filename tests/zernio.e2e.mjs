// End-to-end test of publishing through Zernio against the real built Worker (wrangler dev, local D1 and R2) and a
// fake Zernio. Run after `npm run build` and applying migrations locally:  npm run test:zernio
// It signs in with Sites-style identity headers (the default AUTH_MODE), so it never touches production.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { startFakeZernio } from "./fake-zernio.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const port = 8890 + Math.floor(Math.random() * 100), base = "http://127.0.0.1:" + port;
const owner = "zntest_" + Date.now().toString(36);
const who = { "oai-authenticated-user-id": owner, "oai-authenticated-user-email": owner + "@test.local" };
const settings = { mode: "automatic", duration: 30, dailyLimit: 10, captions: true, framing: "blur", destinations: [], captionTemplate: "{streamer} on {platform} #test" };
const remote = [
  { _id: "acc-ig", platform: "instagram", username: "ig_clips", displayName: "IG", isActive: true },
  { _id: "acc-tt", platform: "tiktok", username: "tt_clips", isActive: true },
  { _id: "acc-yt", platform: "youtube", username: "", displayName: "YT Clips", isActive: true },
  { _id: "acc-li", platform: "linkedin", username: "not_video", isActive: true },
];
let fake, dev, workerToken, streamer;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dash = async body => {
  const r = await fetch(base + "/api/dashboard", body ? { method: "POST", headers: { ...who, "content-type": "application/json" }, body: JSON.stringify(body) } : { headers: who });
  return { status: r.status, body: await r.json() };
};
const worker = (path, init = {}) => fetch(base + path, { ...init, headers: { authorization: "Bearer " + workerToken, "content-type": "application/json", ...init.headers } });
const control = (path, body) => fetch("http://127.0.0.1:" + fake.port + path, { method: "POST", body: body && JSON.stringify(body) });
const fakeLog = async () => (await fetch("http://127.0.0.1:" + fake.port + "/__log")).json();
let clock = Date.now();
async function cron(advanceMs = 0) {
  clock += advanceMs;
  const r = await fetch(base + "/__test/cron?time=" + clock);
  assert.equal(r.status, 200, "publisher run failed: " + (await r.text()).slice(0, 600));
}
async function addClip() {
  const bytes = randomBytes(6000), clip = { id: randomUUID(), streamerId: streamer.id, createdAt: new Date().toISOString(), duration: 30, captions: true, sha: createHash("sha256").update(bytes).digest("hex"), size: bytes.length, reason: "chat" };
  assert.equal((await worker("/api/worker/clips", { method: "POST", body: JSON.stringify(clip) })).status, 200);
  assert.equal((await worker("/api/worker/clips/" + clip.id + "/file", { method: "PUT", headers: { "content-type": "video/mp4" }, body: bytes })).status, 200);
  return { clip, bytes };
}
const postsFor = async clipId => Object.fromEntries((await dash()).body.posts.filter(p => p.clip_id === clipId).map(p => [p.platform, p]));
const sentFor = async clipId => Object.fromEntries((await fakeLog()).posts.filter(p => p.params.mediaItems[0].url.includes(clipId)).map(p => [p.platform, p]));

before(async () => {
  fake = await startFakeZernio({ keys: { sk_test: "Site Owner", sk_mine_123456: "Dan", sk_second_7890: "Dan" }, isolated: ["sk_second_7890"] });
  const vars = { ENABLE_TEST_CRON: "1", ZERNIO_API_KEY: "sk_test", ZERNIO_API_URL: "http://127.0.0.1:" + fake.port + "/api/v1", TOKEN_KEY: randomBytes(32).toString("base64"), MEDIA_KEY: randomBytes(32).toString("base64"), PUBLIC_URL: base };
  dev = spawn(process.execPath, ["--import", "./scripts/sites-env.mjs", "./node_modules/wrangler/bin/wrangler.js", "dev", "--config", "dist/server/wrangler.json", "--local", "--persist-to", ".wrangler/state", "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", "0", ...Object.entries(vars).flatMap(([k, v]) => ["--var", k + ":" + v])], { cwd: root, stdio: "ignore", env: { ...process.env, CI: "true" } });
  for (let i = 0; i < 90; i++) { try { await fetch(base + "/api/worker/config"); break; } catch { await sleep(1000); } }
  assert.equal((await dash({ action: "settings", settings })).status, 200);
  assert.equal((await dash({ action: "control", control: "running" })).status, 200);
  assert.equal((await dash({ action: "add", url: "https://twitch.tv/" + owner })).status, 200);
  streamer = (await dash()).body.streamers[0];
  workerToken = (await dash({ action: "token" })).body.token;
  await control("/__accounts", remote);
  await control("/__mode?platform=tiktok&mode=pending");
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

test("dashboard reports Zernio publishing as available", async () => {
  const { publishing } = (await dash()).body;
  assert.equal(publishing.instagram, false);
  assert.equal(publishing.zernio, true);
  assert.equal(publishing.zernioSource, "site", "without its own key a workspace uses the site's");
  assert.equal(publishing.canSaveKey, true);
});

test("syncing copies Zernio's video accounts and links the first ones to every streamer", async () => {
  const sync = await dash({ action: "syncZernio" });
  assert.equal(sync.status, 200, JSON.stringify(sync.body));
  assert.match(sync.body.message, /Added Instagram @ig_clips, TikTok @tt_clips, YouTube @YT Clips/);
  const { body } = await dash();
  assert.deepEqual(body.accounts.map(a => [a.provider, a.platform, a.username, a.status]).sort(), [["zernio", "instagram", "ig_clips", "connected"], ["zernio", "tiktok", "tt_clips", "connected"], ["zernio", "youtube", "YT Clips", "connected"]], "LinkedIn is left out: it takes no vertical video");
  assert.equal(body.streamers[0].accounts.length, 3);
  assert.ok(!JSON.stringify(body).includes("sk_test"), "the API key never reaches the browser");
  const again = await dash({ action: "syncZernio" });
  assert.equal(again.body.message, "Accounts under this site's shared key are up to date.");
  assert.equal((await dash()).body.accounts.length, 3, "syncing twice adds nothing");
});

test("an approved clip posts once to each linked account, with the right per-platform options", async () => {
  const { clip, bytes } = await addClip();
  await cron();
  let posts = await postsFor(clip.id);
  assert.equal(posts.instagram.state, "published", posts.instagram.error ?? "");
  assert.equal(posts.instagram.permalink, "https://example.test/instagram/" + (await sentFor(clip.id)).instagram._id);
  assert.equal(posts.youtube.state, "published", posts.youtube.error ?? "");
  assert.equal(posts.tiktok.state, "processing", "Zernio is still working on the TikTok post");
  const sent = await sentFor(clip.id);
  for (const p of Object.values(sent)) {
    assert.equal(p.fetchStatus, 200, "Zernio could download the signed link");
    assert.equal(p.bytes, bytes.length);
    assert.equal(p.params.content, owner + " on Twitch #test");
    assert.equal(p.params.publishNow, true);
    assert.match(p.params.mediaItems[0].url, new RegExp("^" + base + "/media/" + clip.id + "\\.mp4\\?e=\\d+&s="));
  }
  assert.deepEqual(sent.youtube.params.platforms[0].platformSpecificData, { title: owner + " on Twitch #test" });
  assert.deepEqual(sent.tiktok.params.tiktokSettings, { draft: true }, "an automatically approved clip goes to TikTok drafts");
  await cron(30_000);  // too soon to check again
  await cron(40_000);  // first check: still pending
  assert.equal((await postsFor(clip.id)).tiktok.state, "processing");
  await cron(61_000);  // second check: published
  posts = await postsFor(clip.id);
  assert.equal(posts.tiktok.state, "published", posts.tiktok.error ?? "");
  assert.match(posts.tiktok.permalink, /^https:\/\/example\.test\/tiktok\//);
  const created = (await fakeLog()).posts.length;
  await cron(120_000); await cron(120_000);
  assert.equal((await fakeLog()).posts.length, created, "never posted twice");
});

test("a clip you approve yourself posts to TikTok directly, with consent given", async () => {
  assert.equal((await dash({ action: "settings", settings: { ...settings, mode: "review" } })).status, 200);
  await dash({ action: "control", control: "running" });
  const { clip } = await addClip();
  await cron(60_000);
  assert.deepEqual(await postsFor(clip.id), {}, "a clip waiting for review is not posted");
  assert.equal((await dash({ action: "reviewClip", id: clip.id, review: "approved" })).status, 200);
  await cron(60_000);
  const { tiktok } = await sentFor(clip.id);
  assert.equal(tiktok.params.tiktokSettings.privacyLevel, "PUBLIC_TO_EVERYONE");
  assert.equal(tiktok.params.tiktokSettings.contentPreviewConfirmed, true);
  assert.equal(tiktok.params.tiktokSettings.expressConsentGiven, true);
  assert.equal(tiktok.params.tiktokSettings.draft, undefined);
  await cron(61_000); await cron(61_000);
  await dash({ action: "settings", settings });
  await dash({ action: "control", control: "running" });
});

test("a rejected post is retried with a fresh key, then marked failed and can be retried by hand", async () => {
  await control("/__mode?platform=youtube&mode=fail");
  const { clip } = await addClip();
  await cron(60_000);
  let { youtube } = await postsFor(clip.id);
  assert.equal(youtube.state, "queued");
  assert.equal(youtube.attempts, 1);
  assert.equal(youtube.error, "Video rejected by platform");
  await cron(5 * 60_000 + 1000);
  await cron(10 * 60_000 + 1000);
  ({ youtube } = await postsFor(clip.id));
  assert.equal(youtube.state, "failed");
  assert.equal(youtube.attempts, 3);
  const keys = (await fakeLog()).log.filter(e => e.method === "POST" && e.path === "/api/v1/posts" && e.idempotencyKey?.startsWith(youtube.id)).map(e => e.idempotencyKey);
  assert.equal(new Set(keys).size, 3, "each attempt uses its own idempotency key");
  await control("/__mode?platform=youtube&mode=published");
  assert.equal((await dash({ action: "retryPost", id: youtube.id })).status, 200);
  await cron(60_000);
  assert.equal((await postsFor(clip.id)).youtube.state, "published");
});

test("an account disconnected on Zernio stops posting and is marked after a sync", async () => {
  await control("/__accounts", remote.map(a => a._id === "acc-ig" ? { ...a, isActive: false } : a));
  const { clip } = await addClip();
  await cron(60_000);
  let { body } = await dash();
  const ig = body.accounts.find(a => a.platform === "instagram");
  assert.equal(ig.status, "expired", "a 403 ACCOUNT_DISCONNECTED marks the account");
  assert.match(ig.last_error, /disconnected on Zernio/);
  assert.equal((await postsFor(clip.id)).instagram.state, "queued", "the post waits for the account rather than failing");
  await control("/__accounts", remote);
  await dash({ action: "syncZernio" });
  ({ body } = await dash());
  assert.equal(body.accounts.find(a => a.platform === "instagram").status, "connected", "reconnecting on Zernio and syncing restores it");
  await cron(60_000);
  assert.equal((await postsFor(clip.id)).instagram.state, "published");
});

test("removing an account in Clipflow unlinks it", async () => {
  const { body } = await dash();
  const yt = body.accounts.find(a => a.platform === "youtube");
  const removed = await dash({ action: "disconnect", id: yt.id });
  assert.match(removed.body.message, /Disconnected YouTube account @YT Clips/);
  assert.ok(!(await fakeLog()).log.some(e => e.method === "DELETE" && e.path !== "/api/v1/accounts/acc-yt") && (await fakeLog()).log.some(e => e.method === "DELETE" && e.path === "/api/v1/accounts/acc-yt"), "disconnected on Zernio too");
  const after = (await dash()).body;
  assert.ok(!after.accounts.some(a => a.id === yt.id));
  assert.ok(!after.streamers[0].accounts.includes(yt.id));
});

test("a workspace's own Zernio key is checked, stored without ever being shown, and used for posting", async () => {
  const wrong = await dash({ action: "addZernioKey", key: "sk_not_a_real_key" });
  assert.equal(wrong.status, 400);
  assert.match(wrong.body.error, /didn't accept that key/);
  const saved = await dash({ action: "addZernioKey", key: "sk_mine_123456" });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.match(saved.body.message, /^Added Zernio key Dan\./);
  const { body } = await dash();
  assert.equal(body.publishing.zernioSource, "workspace");
  assert.deepEqual(body.publishing.zernioKeys.map(k => [k.label, k.accounts]), [["Dan", 2]], "the accounts it can see now belong to it");
  assert.ok(!JSON.stringify(body).includes("sk_mine_123456"), "the key never reaches the browser");
  assert.ok(!("zernio_key_enc" in body.settings), "not even encrypted");
  const { clip } = await addClip();
  await cron(60_000);
  const used = (await fakeLog()).log.filter(e => e.method === "POST" && e.path === "/api/v1/posts").at(-1);
  assert.equal(used.auth, "sk_mine_123456", "posts go out with the workspace's key, not the site's");
  assert.equal((await postsFor(clip.id)).instagram.state, "published");
});

test("connecting an account from Clipflow goes through the platform sign-in and links it to the streamer", async () => {
  const start = await fetch(base + "/api/connections/zernio/start?platform=youtube&streamer=" + streamer.id, { headers: who, redirect: "manual" });
  assert.equal(start.status, 302);
  const cookie = start.headers.get("set-cookie").split(";")[0];
  assert.match(cookie, new RegExp("^zn_connect=" + streamer.id + "\\.[0-9a-f-]{36}$"), "streamer and key travel in the cookie");
  // The platform's sign-in page (fake) adds the account and sends the browser back with its id.
  const signin = await fetch(start.headers.get("location"), { redirect: "manual" });
  const callback = signin.headers.get("location");
  assert.match(callback, /^http:\/\/127\.0\.0\.1:\d+\/api\/connections\/zernio\/callback\?connected=youtube&profileId=prof-1&accountId=acc-new-\d+&username=new_youtube$/);
  const done = await fetch(callback, { headers: { ...who, cookie }, redirect: "manual" });
  assert.match(done.headers.get("location"), /\/\?connected=youtube&account=new_youtube$/);
  assert.match(done.headers.get("set-cookie"), /zn_connect=;.*Max-Age=0/, "the cookie is cleared");
  const { body } = await dash();
  const yt = body.accounts.find(a => a.username === "new_youtube");
  assert.equal(yt.platform, "youtube");
  assert.ok(body.streamers[0].accounts.includes(yt.id), "linked to the streamer it was started from");
  assert.match(body.events[0].message, /Connected YouTube account @new_youtube/);
});

test("a cancelled sign-in returns with its reason and adds nothing", async () => {
  const before = (await dash()).body.accounts.length;
  const start = await fetch(base + "/api/connections/zernio/start?platform=tiktok", { headers: who, redirect: "manual" });
  const signin = await fetch(start.headers.get("location") + "&deny=1", { redirect: "manual" });
  const done = await fetch(signin.headers.get("location"), { headers: who, redirect: "manual" });
  assert.match(decodeURIComponent(done.headers.get("location")), /connect_error=The user cancelled/);
  assert.equal((await dash()).body.accounts.length, before);
  const bad = await fetch(base + "/api/connections/zernio/start?platform=myspace", { headers: who, redirect: "manual" });
  assert.match(decodeURIComponent(bad.headers.get("location")), /connect_error=That platform can't be connected/);
});

test("per-account options change how posts are sent", async () => {
  const { body } = await dash();
  const tt = body.accounts.find(a => a.platform === "tiktok"), yt = body.accounts.find(a => a.username === "new_youtube");
  assert.deepEqual(tt.options, { tiktokMode: "reviewed", tiktokPrivacy: "PUBLIC_TO_EVERYONE", allowComments: true, youtubeVisibility: "public" }, "defaults");
  assert.equal((await dash({ action: "accountOptions", id: tt.id, options: { tiktokMode: "direct", tiktokPrivacy: "SELF_ONLY", allowComments: false } })).status, 200);
  assert.equal((await dash({ action: "accountOptions", id: yt.id, options: { youtubeVisibility: "unlisted" } })).status, 200);
  assert.equal((await dash({ action: "accountOptions", id: yt.id, options: { youtubeVisibility: "secret" } })).status, 400, "unknown values are refused");
  await control("/__mode?platform=tiktok&mode=published");
  // Each account sends one post per minute, finishing earlier ones first, so give the queue a few minutes.
  const sentAll = async (clipId, platforms) => { for (let i = 0; i < 8; i++) { await cron(61_000); const sent = await sentFor(clipId); if (platforms.every(p => sent[p])) return sent; } return sentFor(clipId); };
  const { clip } = await addClip();
  const sent = await sentAll(clip.id, ["tiktok", "youtube"]);
  assert.deepEqual(sent.tiktok.params.tiktokSettings, { privacyLevel: "SELF_ONLY", allowComment: false, allowDuet: true, allowStitch: true, commercialContentType: "none", contentPreviewConfirmed: true, expressConsentGiven: true }, "direct mode publishes even an automatically approved clip");
  assert.equal(sent.youtube.params.visibility, "unlisted");
  assert.equal((await dash({ action: "accountOptions", id: tt.id, options: { tiktokMode: "drafts" } })).status, 200);
  const second = await addClip();
  assert.deepEqual((await sentAll(second.clip.id, ["tiktok"])).tiktok.params.tiktokSettings, { draft: true });
});

test("a second Zernio key adds a separate set of accounts that post with their own key", async () => {
  const added = await dash({ action: "addZernioKey", key: "sk_second_7890" });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  assert.match(added.body.message, /^Added Zernio key Dan \(2\)\. No accounts connected under Dan \(2\) yet\./, "same owner name, numbered");
  assert.equal((await dash({ action: "addZernioKey", key: "sk_second_7890" })).status, 409, "the same key can't be added twice");
  let { body } = await dash();
  const second = body.publishing.zernioKeys.find(k => k.label === "Dan (2)");
  // Connect TikTok under the second key.
  const start = await fetch(base + "/api/connections/zernio/start?platform=tiktok&key=" + second.id, { headers: who, redirect: "manual" });
  const cookie = start.headers.get("set-cookie").split(";")[0];
  const signin = await fetch(start.headers.get("location"), { redirect: "manual" });
  const done = await fetch(signin.headers.get("location"), { headers: { ...who, cookie }, redirect: "manual" });
  assert.match(done.headers.get("location"), /connected=tiktok&account=new_tiktok_2$/);
  ({ body } = await dash());
  const tt2 = body.accounts.find(a => a.username === "new_tiktok_2");
  assert.equal(tt2.zernio_key_id, second.id);
  assert.deepEqual(body.publishing.zernioKeys.map(k => [k.label, k.accounts]), [["Dan", 3], ["Dan (2)", 1]]);
  // Refresh reads every key and keeps each account under its own key.
  assert.equal((await dash({ action: "syncZernio" })).status, 200);
  assert.equal((await dash()).body.accounts.find(a => a.username === "new_tiktok_2").zernio_key_id, second.id);
  // A clip routed to it posts with the second key.
  assert.equal((await dash({ action: "assign", streamerId: streamer.id, accounts: [tt2.id] })).status, 200);
  const { clip } = await addClip();
  for (let i = 0; i < 4 && !(await sentFor(clip.id)).tiktok; i++) await cron(61_000);
  const post = (await fakeLog()).log.filter(e => e.method === "POST" && e.path === "/api/v1/posts").at(-1);
  assert.equal(post.auth, "sk_second_7890");
});

test("removing a key removes its accounts; the others keep posting", async () => {
  let { body } = await dash();
  const second = body.publishing.zernioKeys.find(k => k.label === "Dan (2)");
  const removed = await dash({ action: "removeZernioKey", id: second.id });
  assert.equal(removed.status, 200);
  assert.match(removed.body.message, /Removed Zernio key Dan \(2\) and the accounts connected under it/);
  ({ body } = await dash());
  assert.ok(!body.accounts.some(a => a.username === "new_tiktok_2"));
  assert.deepEqual(body.publishing.zernioKeys.map(k => k.label), ["Dan"]);
  assert.ok(!body.streamers[0].accounts.length || body.streamers[0].accounts.every(id => body.accounts.some(a => a.id === id)), "no links to removed accounts");
  const first = body.publishing.zernioKeys[0];
  assert.equal((await dash({ action: "removeZernioKey", id: first.id })).status, 200);
  ({ body } = await dash());
  assert.equal(body.publishing.zernioSource, "site", "with no keys left, the site's shared key is used");
});
