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
  fake = await startFakeZernio({ isolated: ["sk_second_7890", "sk_full_1111"], keys: { sk_test: "Site Owner", sk_mine_123456: "Dan", sk_second_7890: "Dan", sk_full_1111: "Full Owner" }, limits: { sk_full_1111: 0 } });
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

test("a post held by TikTok's daily limit waits for it, without timing out, retrying or starting others", async () => {
  // Past a full day, so the posts here no longer count towards later tests' daily limits.
  const until = new Date(clock + 25 * 3600_000).toISOString();
  await control("/__mode?platform=tiktok&mode=held&until=" + until);
  const first = (await addClip()).clip;
  await cron(60_000);
  let { tiktok } = await postsFor(first.id);
  assert.equal(tiktok.state, "processing");
  assert.match(tiktok.error, /daily posting limit/);
  const second = (await addClip()).clip;
  await cron(61_000); await cron(61_000);
  assert.equal((await postsFor(second.id)).tiktok.state, "queued", "nothing else starts while a post is held");
  // Hours later, before the hold ends: still waiting, not timed out or sent again.
  await cron(3 * 3600_000);
  ({ tiktok } = await postsFor(first.id));
  assert.deepEqual([tiktok.state, tiktok.attempts], ["processing", 0]);
  assert.equal(Object.values((await fakeLog()).posts).filter(p => p.platform === "tiktok" && p.params.mediaItems[0].url.includes(first.id)).length, 1, "sent to Zernio once");
  // Once the hold is over it goes out, and the next one starts.
  await control("/__release"); await control("/__mode?platform=tiktok&mode=pending");
  await cron(Date.parse(until) - clock + 120_000);
  ({ tiktok } = await postsFor(first.id));
  assert.equal(tiktok.state, "published");
  await cron(61_000);
  assert.notEqual((await postsFor(second.id)).tiktok.state, "queued");
  await cron(61_000); await cron(61_000);
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
  assert.deepEqual(tt.options, { tiktokMode: "reviewed", tiktokPrivacy: "PUBLIC_TO_EVERYONE", allowComments: true, youtubeVisibility: "public", dailyLimit: null, gapMinutes: 0, whenFull: "review", overflowToDrafts: true }, "defaults");
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

test("a clip can be posted again by hand, once at a time, and posting a clip awaiting review approves it", async () => {
  const ig = (await dash()).body.accounts.find(a => a.platform === "instagram");
  const { clip } = await addClip();
  for (let i = 0; i < 4 && (await postsFor(clip.id)).instagram?.state !== "published"; i++) await cron(61_000);
  assert.equal((await postsFor(clip.id)).instagram.state, "published");
  const again = await dash({ action: "postClip", id: clip.id, accounts: [ig.id] });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.match(again.body.message, /Instagram @ig_clips \(again\)/);
  const twice = await dash({ action: "postClip", id: clip.id, accounts: [ig.id] });
  assert.equal(twice.status, 409, "one unfinished post per clip and account");
  assert.match(twice.body.error, /Already on its way to Instagram @ig_clips/);
  for (let i = 0; i < 4 && (await dash()).body.posts.filter(p => p.clip_id === clip.id && p.platform === "instagram" && p.state === "published").length < 2; i++) await cron(61_000);
  const igPosts = (await dash()).body.posts.filter(p => p.clip_id === clip.id && p.platform === "instagram");
  assert.deepEqual(igPosts.map(p => [p.round, p.state]).sort(), [[0, "published"], [1, "published"]]);
  const sent = (await fakeLog()).posts.filter(p => p.platform === "instagram" && p.params.mediaItems[0].url.includes(clip.id));
  assert.equal(sent.length, 2, "Zernio got a second, separate post");
  await cron(61_000); await cron(61_000);
  assert.equal((await dash()).body.posts.filter(p => p.clip_id === clip.id && p.platform === "instagram").length, 2, "the automatic queue never adds a third");
  // In review mode a new clip waits; posting it by hand approves it.
  await dash({ action: "settings", settings: { ...settings, mode: "review" } });
  await dash({ action: "control", control: "running" });
  const pending = (await addClip()).clip;
  assert.equal((await dash()).body.clips.find(c => c.id === pending.id).review, "pending");
  assert.equal((await dash({ action: "postClip", id: pending.id, accounts: [ig.id] })).status, 200);
  assert.equal((await dash()).body.clips.find(c => c.id === pending.id).review, "approved");
  for (let i = 0; i < 4 && (await postsFor(pending.id)).instagram?.state !== "published"; i++) await cron(61_000);
  assert.equal((await postsFor(pending.id)).instagram.state, "published");
  assert.equal((await dash({ action: "postClip", id: randomUUID(), accounts: [ig.id] })).status, 404);
  await dash({ action: "settings", settings });
  await dash({ action: "control", control: "running" });
});

test("several selected clips can be posted together", async () => {
  const ig = (await dash()).body.accounts.find(a => a.platform === "instagram");
  // Review mode, so nothing posts by itself; room for more posts today than the earlier tests left.
  await dash({ action: "settings", settings: { ...settings, mode: "review", dailyLimit: 50 } });
  await dash({ action: "control", control: "running" });
  const one = (await addClip()).clip, two = (await addClip()).clip;
  const r = await dash({ action: "postClips", ids: [one.id, two.id, randomUUID()], accounts: [ig.id] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.message, /^Posting 2 clips to Instagram @ig_clips \(2 posts\)\. Each account posts about one a minute, up to 50 a day/);
  const clips = (await dash()).body.clips.filter(c => c.id === one.id || c.id === two.id);
  assert.deepEqual(clips.map(c => c.review), ["approved", "approved"], "posting approves them");
  const again = await dash({ action: "postClips", ids: [one.id, two.id], accounts: [ig.id] });
  assert.equal(again.status, 409, "both already on their way");
  const out = async () => (await dash()).body.posts.filter(p => (p.clip_id === one.id || p.clip_id === two.id) && p.platform === "instagram");
  for (let i = 0; i < 6 && (await out()).filter(p => p.state === "published").length < 2; i++) await cron(61_000);
  assert.deepEqual((await out()).map(p => p.state), ["published", "published"], "one a minute, both out");
  await dash({ action: "settings", settings });
  await dash({ action: "control", control: "running" });
});

test("a clip can be saved to TikTok drafts by hand, and a full drafts inbox holds it instead of failing", async () => {
  const { body } = await dash();
  const tt = body.accounts.find(a => a.platform === "tiktok"), ig = body.accounts.find(a => a.platform === "instagram");
  await control("/__mode?platform=tiktok&mode=published");
  // A day on, so the drafts earlier tests sent no longer count against TikTok's 5 a day.
  await cron(25 * 3600_000);
  const { clip } = await addClip();
  assert.equal((await dash({ action: "postClip", id: clip.id, accounts: [ig.id], draft: true })).status, 400, "drafts are TikTok only");
  const saved = await dash({ action: "postClip", id: clip.id, accounts: [tt.id, ig.id], draft: true });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.match(saved.body.message, /TikTok drafts of TikTok @tt_clips.*Instagram @ig_clips skipped: drafts are TikTok only/);
  const mine = async () => (await dash()).body.posts.find(p => p.clip_id === clip.id && p.platform === "tiktok");
  assert.ok((await mine()).draft, "marked as a draft in the queue");
  for (let i = 0; i < 6 && (await mine()).state !== "published"; i++) await cron(61_000);
  assert.deepEqual((await sentFor(clip.id)).tiktok.params.tiktokSettings, { draft: true });
  // TikTok refuses the next draft: its drafts inbox is full. The post waits two hours without using an attempt.
  await control("/__mode?platform=tiktok&mode=pendingfull");
  const second = (await addClip()).clip;
  assert.equal((await dash({ action: "postClip", id: second.id, accounts: [tt.id], draft: true })).status, 200);
  const held = async () => (await dash()).body.posts.find(p => p.clip_id === second.id && p.platform === "tiktok");
  for (let i = 0; i < 6 && !/drafts inbox is full/.test((await held()).error ?? ""); i++) await cron(61_000);
  const h = await held();
  assert.equal(h.state, "queued");
  assert.equal(h.attempts, 0, "not counted as a failed attempt");
  assert.match(h.error, /TikTok's drafts inbox is full/);
  await control("/__mode?platform=tiktok&mode=published");
  await cron(30 * 60_000);
  assert.equal((await held()).state, "queued", "still waiting within the two hours");
  for (let i = 0; i < 4 && (await held()).state !== "published"; i++) await cron(61 * 60_000);
  assert.equal((await held()).state, "published", "goes out once TikTok has room");
});

test("an account's own daily limit and spacing pace its posts", async () => {
  const ig = (await dash()).body.accounts.find(a => a.platform === "instagram");
  assert.equal((await dash({ action: "accountOptions", id: ig.id, options: { gapMinutes: 60, dailyLimit: 40 } })).status, 200);
  assert.equal((await dash({ action: "accountOptions", id: ig.id, options: { gapMinutes: 7 } })).status, 200, "any whole minutes are accepted");
  assert.equal((await dash({ action: "accountOptions", id: ig.id, options: { dailyLimit: 0 } })).status, 400);
  await dash({ action: "accountOptions", id: ig.id, options: { gapMinutes: 60 } });
  await dash({ action: "settings", settings: { ...settings, mode: "review", dailyLimit: 50 } });
  await dash({ action: "control", control: "running" });
  await cron(2 * 3600_000);  // well past the last post
  const a = (await addClip()).clip, b = (await addClip()).clip;
  await dash({ action: "postClips", ids: [a.id, b.id], accounts: [ig.id] });
  const state = async id => (await dash()).body.posts.find(p => p.clip_id === id && p.platform === "instagram");
  for (let i = 0; i < 4 && (await state(a.id)).state !== "published"; i++) await cron(61_000);
  assert.equal((await state(a.id)).state, "published");
  await cron(5 * 60_000);
  const waiting = await state(b.id);
  assert.equal(waiting.state, "queued", "the second waits for the gap");
  assert.match(waiting.error, /Waiting: spacing posts 60 minutes apart/);
  await cron(60 * 60_000);
  for (let i = 0; i < 3 && (await state(b.id)).state !== "published"; i++) await cron(61_000);
  assert.equal((await state(b.id)).state, "published", "then goes out");
  assert.equal((await state(b.id)).error, null);
  await dash({ action: "accountOptions", id: ig.id, options: { gapMinutes: 0, dailyLimit: null } });
  await dash({ action: "settings", settings });
  await dash({ action: "control", control: "running" });
});

test("a clip posted by hand in the TikTok app can be marked as posted, and is then not sent automatically", async () => {
  const tt = (await dash()).body.accounts.find(a => a.platform === "tiktok");
  await dash({ action: "settings", settings: { ...settings, mode: "review" } });
  await dash({ action: "control", control: "running" });
  const { clip } = await addClip();
  // Queued for TikTok, then posted by hand before Clipflow got to it.
  assert.equal((await dash({ action: "postClip", id: clip.id, accounts: [tt.id] })).status, 200);
  const marked = await dash({ action: "markPosted", id: clip.id, accountId: tt.id });
  assert.equal(marked.status, 200, JSON.stringify(marked.body));
  assert.match(marked.body.message, /Marked .* as posted to TikTok @tt_clips; it's out of the queue\./);
  await cron(61_000); await cron(61_000);
  const rows = (await dash()).body.posts.filter(p => p.clip_id === clip.id && p.platform === "tiktok");
  assert.deepEqual(rows.map(p => p.state), ["published"], "one post, recorded as published");
  assert.equal((await sentFor(clip.id)).tiktok, undefined, "never sent to Zernio");
  // Posting it by hand again records another one.
  assert.equal((await dash({ action: "markPosted", id: clip.id, accountId: tt.id })).status, 200);
  assert.equal((await dash()).body.posts.filter(p => p.clip_id === clip.id && p.platform === "tiktok").length, 2);
  assert.equal((await dash({ action: "markPosted", id: clip.id, accountId: randomUUID() })).status, 404);
  await dash({ action: "settings", settings });
  await dash({ action: "control", control: "running" });
});

test("once a TikTok account has sent 15 in a day, new clips wait for review there but still post elsewhere", async () => {
  await cron(25 * 3600_000);  // a fresh day for every account
  await dash({ action: "settings", settings: { ...settings, dailyLimit: 50 } });
  await dash({ action: "control", control: "running" });
  await control("/__mode?platform=tiktok&mode=published");
  const tiktok = async id => (await dash()).body.posts.find(p => p.clip_id === id && p.platform === "tiktok");
  const instagram = async id => (await dash()).body.posts.find(p => p.clip_id === id && p.platform === "instagram");
  const first = [];
  for (let i = 0; i < 15; i++) first.push((await addClip()).clip);
  for (let i = 0; i < 30; i++) {
    const done = (await dash()).body.posts.filter(p => p.platform === "tiktok" && p.state === "published" && first.some(c => c.id === p.clip_id)).length;
    if (done >= 15) break;
    await cron(61_000);
  }
  assert.equal((await dash()).body.posts.filter(p => p.platform === "tiktok" && p.state === "published" && first.some(c => c.id === p.clip_id)).length, 15);
  // The 16th: held for review on TikTok, posted on Instagram as usual.
  const held = (await addClip()).clip, skipped = (await addClip()).clip;
  for (let i = 0; i < 4; i++) await cron(61_000);
  let post = await tiktok(held.id);
  assert.equal(post.state, "review");
  assert.match(post.error, /15 posts a day were used up/);
  assert.equal((await instagram(held.id)).state, "published", "the other accounts still post it");
  assert.equal((await sentFor(held.id)).tiktok, undefined, "nothing sent to TikTok");
  const dash1 = await dash();
  assert.equal(dash1.body.posts.filter(p => p.state === "review").length, 2);
  // Queued by hand: it waits for room instead of being held again.
  assert.equal((await dash({ action: "reviewPosts", ids: [post.id], op: "queue" })).status, 200);
  await cron(61_000);
  post = await tiktok(held.id);
  assert.equal(post.state, "queued");
  assert.match(post.error, /Waiting: TikTok/);
  // Skipped: never posted, and not queued again.
  const skip = await tiktok(skipped.id);
  assert.equal((await dash({ action: "reviewPosts", ids: [skip.id], op: "skip" })).status, 200);
  assert.equal((await dash({ action: "reviewPosts", ids: [skip.id], op: "queue" })).status, 409, "only posts waiting for review");
  // A day later the queued one goes out; the skipped one stays skipped.
  await cron(24 * 3600_000);
  for (let i = 0; i < 4 && (await tiktok(held.id)).state !== "published"; i++) await cron(61_000);
  assert.equal((await tiktok(held.id)).state, "published");
  assert.deepEqual((await dash()).body.posts.filter(p => p.clip_id === skipped.id && p.platform === "tiktok").map(p => p.state), ["skipped"]);
  assert.equal((await sentFor(skipped.id)).tiktok, undefined);
  await control("/__mode?platform=tiktok&mode=pending");
  await cron(25 * 3600_000);
  // Any platform: an Instagram account at its own limit queues (set to queue) or holds (set to hold) new clips.
  const ig = (await dash()).body.accounts.find(a => a.platform === "instagram");
  assert.equal((await dash({ action: "accountOptions", id: ig.id, options: { dailyLimit: 1, whenFull: "queue" } })).status, 200);
  assert.equal((await dash({ action: "accountOptions", id: ig.id, options: { whenFull: "later" } })).status, 400);
  const one = (await addClip()).clip;
  for (let i = 0; i < 4 && (await instagram(one.id))?.state !== "published"; i++) await cron(61_000);
  assert.equal((await instagram(one.id)).state, "published");
  const two = (await addClip()).clip;
  await cron(61_000); await cron(61_000);
  assert.equal((await instagram(two.id)).state, "queued", "set to queue: it waits for room");
  assert.equal((await dash({ action: "accountOptions", id: ig.id, options: { whenFull: "review" } })).status, 200);
  const three = (await addClip()).clip;
  await cron(61_000);
  const igHeld = await instagram(three.id);
  assert.equal(igHeld.state, "review", "set to hold: it waits for review");
  assert.match(igHeld.error, /daily limit of 1 was reached/);
  assert.equal((await instagram(two.id)).state, "queued", "one already queued keeps its place");
  await dash({ action: "accountOptions", id: ig.id, options: { dailyLimit: null, whenFull: "review" } });
  await dash({ action: "reviewPosts", ids: [igHeld.id], op: "skip" });
  await cron(25 * 3600_000);
  await dash({ action: "settings", settings });
  await dash({ action: "control", control: "running" });
});

test("deleting a clip drops its unsent posts and cancels one Zernio is holding", async () => {
  const until = new Date(clock + 25 * 3600_000).toISOString();
  await control("/__mode?platform=tiktok&mode=held&until=" + until);
  await addClip();
  // The account's oldest queued TikTok post goes to Zernio next, and is held there.
  const heldPost = async () => (await dash()).body.posts.find(p => p.platform === "tiktok" && p.state === "processing");
  for (let i = 0; i < 6 && !(await heldPost()); i++) await cron(61_000);
  const held = await heldPost();
  assert.ok(held, "a TikTok post is held by Zernio");
  const clip = { id: held.clip_id };
  const zernioId = (await fakeLog()).posts.find(p => p.platform === "tiktok" && p.params.mediaItems[0].url.includes(clip.id))._id;
  assert.equal((await dash({ action: "deleteClip", id: clip.id })).status, 200);
  assert.ok(!(await fakeLog()).posts.some(p => p._id === zernioId), "cancelled on Zernio");
  assert.ok(!(await dash()).body.posts.some(p => p.clip_id === clip.id && p.state !== "published"), "no unsent posts left");
  await control("/__release"); await control("/__mode?platform=tiktok&mode=pending");
  await cron(25 * 3600_000);
});

test("analytics: published posts get their views and likes from Zernio about hourly", async () => {
  const calls = async () => (await fakeLog()).log.filter(e => e.path === "/api/v1/analytics").length;
  await cron(61 * 60_000);  // more than an hour on: due for a read
  const after = await calls();
  assert.ok(after > 0, "Zernio's analytics were read");
  await cron(60_000);
  assert.equal(await calls(), after, "not again within the hour");
  const { posts } = (await dash()).body;
  assert.equal((await dash()).body.analytics, undefined, "analytics load on their own, not with every dashboard load");
  const { analytics } = await (await fetch(base + "/api/analytics", { headers: who })).json();
  // Posts of an account removed earlier can't be read any more; the rest all can.
  // Posts made by hand (marked as posted) have no Zernio record to read numbers from; the rest all do.
  const published = posts.filter(p => p.state === "published" && p.account && p.permalink);
  assert.ok(published.length > 0);
  assert.ok(published.every(p => p.views === 1000 && p.likes === 50), "every published post is matched to its numbers");
  assert.ok(analytics.totals.measured >= published.length);
  assert.equal(analytics.totals.views, 1000 * analytics.totals.measured);
  assert.equal(analytics.top[0].views, 1000);
  assert.equal(analytics.daily.posts.length, 14);
  assert.ok(analytics.streamers[0].posts > 0 && analytics.streamers[0].views > 0);
  assert.ok(analytics.accounts.some(a => a.views > 0));
  assert.ok(analytics.clips.total >= analytics.clips.approved);
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

test("a full Zernio account says so, and how to make room", async () => {
  assert.equal((await dash({ action: "addZernioKey", key: "sk_full_1111" })).status, 200);
  const full = (await dash()).body.publishing.zernioKeys.find(k => k.label === "Full Owner");
  const start = await fetch(base + "/api/connections/zernio/start?platform=tiktok&key=" + full.id, { headers: who, redirect: "manual" });
  assert.match(decodeURIComponent(start.headers.get("location")), /connect_error=The Zernio account Full Owner is full: its free plan holds 2 social accounts\. Add a payment method .* or add another Zernio key/);
  assert.equal((await dash({ action: "removeZernioKey", id: full.id })).status, 200);
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
