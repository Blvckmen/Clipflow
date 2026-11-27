// End-to-end test of Instagram publishing against the real built Worker (wrangler dev, local D1 and R2) and a
// fake Instagram. Run after `npm run build` and applying migrations locally:  npm run test:publishing
// It signs in with Sites-style identity headers (the default AUTH_MODE), so it never touches production.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, openSync } from "node:fs";
import { createHash, createHmac, randomUUID, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { startFakeInstagram } from "./fake-instagram.mjs";

import { defaultEdit, defaultStyle } from "../worker/edit.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const port = 8790 + Math.floor(Math.random() * 100), base = "http://127.0.0.1:" + port;
const owner = "pubtest_" + Date.now().toString(36);
const who = { "oai-authenticated-user-id": owner, "oai-authenticated-user-email": owner + "@test.local" };
let fake, dev, directRuntime, workerToken, streamer;
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

// A stand-in for Twitch's sign-in (token) and API (who signed in), for Sign in with Twitch.
let fakeTwitch;
const twitchUser = { id: "4242" + Date.now().toString().slice(-6), login: "tester", display_name: "Tester", email: "tester@test.local" };
// A stand-in for Stripe's API (checkout and billing portal sessions); webhooks are signed here with the same secret.
let fakeStripe;
const stripeAsked = [];
async function startFakeStripe() {
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    let body = ""; req.on("data", c => body += c); req.on("end", () => {
      stripeAsked.push({ path: req.url, auth: req.headers.authorization, params: new URLSearchParams(body) });
      if (req.url === "/checkout/sessions") return res.end(JSON.stringify({ url: "https://checkout.stripe.test/c" }));
      if (req.url === "/billing_portal/sessions") return res.end(JSON.stringify({ url: "https://billing.stripe.test/p" }));
      res.statusCode = 404; res.end("{}");
    });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  return { server, url: "http://127.0.0.1:" + server.address().port };
}
async function startFakeTwitch() {
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    let body = ""; req.on("data", c => body += c); req.on("end", () => {
      if (req.url === "/oauth2/token") { const p = new URLSearchParams(body); return res.end(JSON.stringify(p.get("client_secret") === "twitch-secret" && p.get("code") === "good-code" ? { access_token: "user-token" } : {})); }
      if (req.url === "/helix/users" && req.headers.authorization === "Bearer user-token") return res.end(JSON.stringify({ data: [twitchUser] }));
      res.statusCode = 401; res.end("{}");
    });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  return { server, url: "http://127.0.0.1:" + server.address().port };
}

before(async () => {
  fake = await startFakeInstagram();
  fakeTwitch = await startFakeTwitch();
  fakeStripe = await startFakeStripe();

  const graph = "http://127.0.0.1:" + fake.port;
  const vars = { STRIPE_SECRET_KEY: "sk_test_fake", STRIPE_WEBHOOK_SECRET: "whsec_test", STRIPE_API_URL: fakeStripe.url, TWITCH_CLIENT_ID: "twitch-app", TWITCH_CLIENT_SECRET: "twitch-secret", TWITCH_AUTH_URL: fakeTwitch.url, TWITCH_API_URL: fakeTwitch.url, AUTH_MODE: "sites", ZERNIO_API_KEY: "", ENABLE_TEST_CRON: "1", ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", INSTAGRAM_APP_ID: "test-app", INSTAGRAM_APP_SECRET: "test-secret", TOKEN_KEY: randomBytes(32).toString("base64"), MEDIA_KEY: randomBytes(32).toString("base64"), PUBLIC_URL: base, INSTAGRAM_AUTH_URL: graph, INSTAGRAM_API_URL: graph, INSTAGRAM_GRAPH_URL: graph };
  if(process.env.E2E_DIRECT === "1") {
    const { Miniflare } = await import("miniflare");
    const { resolve } = await import("node:path");
    const {readdirSync}=await import("node:fs");
    const modules=["index.js",...readdirSync("dist/server",{recursive:true}).filter(p=>/\.m?js$/.test(p)&&p!=="index.js")].map(p=>({type:"ESModule",path:resolve("dist/server",p)}));
    const persist=resolve(process.env.E2E_PERSIST_DIR || ".wrangler/state", "v3");
    directRuntime=new Miniflare({port,host:"127.0.0.1",modules,modulesRoot:resolve("dist/server"),compatibilityDate:"2026-05-15",compatibilityFlags:["nodejs_compat"],bindings:vars,d1Databases:{DB:"00000000-0000-4000-8000-000000000000"},d1Persist:resolve(persist,"d1"),r2Buckets:{BUCKET:"site-creator-r2"},r2Persist:resolve(persist,"r2")});
    await directRuntime.ready;
  } else {
  dev = spawn(process.execPath, ["--import", "./scripts/sites-env.mjs", "./node_modules/wrangler/bin/wrangler.js", "dev", "--config", "dist/server/wrangler.json", "--local", "--persist-to", process.env.E2E_PERSIST_DIR || ".wrangler/state", "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", "0", ...Object.entries(vars).flatMap(([k, v]) => ["--var", k + ":" + v])], { cwd: root, stdio: process.env.E2E_DEV_LOG ? ["ignore", openSync(process.env.E2E_DEV_LOG, "w"), "pipe"] : "ignore", env: { ...process.env, CI: "true" } });
  // E2E_DEV_LOG=<file> keeps the Worker's own log (console.error from the publisher and the caption writer).
  if (process.env.E2E_DEV_LOG) dev.stderr.on("data", d => appendFileSync(process.env.E2E_DEV_LOG, d));
  for (let i = 0; i < 90; i++) { if (dev.exitCode !== null) throw new Error("Local test server exited with code " + dev.exitCode + "; inspect E2E_DEV_LOG."); try { await fetch(base + "/api/worker/config", {signal:AbortSignal.timeout(2000)}); break; } catch { await sleep(1000); } }
  }
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
  } finally { dev?.kill(); await directRuntime?.dispose(); fake?.server.close(); fakeTwitch?.server.close(); fakeStripe?.server.close(); }
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

test("a lost publish response is checked, never sent again; a clip rejected while Instagram processes it isn't posted", async () => {
  const publishes = async () => (await fakeLog()).log.filter(e => e.path.endsWith("/media_publish")).length;
  // Lost answer: Instagram publishes, but Clipflow hears a 500.
  const lost = await addClip();
  await cron();
  await cron(61_000);  // still IN_PROGRESS
  await fetch("http://127.0.0.1:" + fake.port + "/__lose_publish", { method: "POST" });
  const before = await publishes();
  await cron(61_000);  // FINISHED -> publish (answer lost)
  let post = (await posts()).find(p => p.clip_id === lost.clip.id);
  assert.equal(post.state, "processing", "kept with its container, not sent afresh: " + (post.error ?? ""));
  assert.match(post.error ?? "", /Checking whether it posted/);
  await cron(301_000);  // checked again: Instagram says PUBLISHED
  post = (await posts()).find(p => p.clip_id === lost.clip.id);
  assert.equal(post.state, "published", post.error ?? "");
  assert.equal(await publishes(), before + 1, "published once");
  // Rejected after the upload started, before Instagram finished: never published, and the post goes.
  const late = await addClip();
  await cron(120_000);
  assert.equal((await posts()).find(p => p.clip_id === late.clip.id)?.state, "processing");
  await cron(61_000);  // still IN_PROGRESS
  assert.equal((await dash({ action: "reviewClip", id: late.clip.id, review: "rejected" })).status, 200);
  const was = await publishes();
  await cron(61_000);  // FINISHED, but the clip is rejected now
  assert.equal(await publishes(), was, "not published");
  assert.equal((await posts()).find(p => p.clip_id === late.clip.id), undefined, "its post is gone");
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
  // The same links set from the account's side (Connections): only that account's streamers change.
  assert.equal((await dash({ action: "assignAccount", accountId: other.id, streamers: [randomUUID()] })).status, 404, "only your own streamers");
  let r = await dash({ action: "assignAccount", accountId: other.id, streamers: [] });
  assert.equal(r.status, 200);
  assert.match(r.body.message, /no longer posts any streamer's clips/);
  assert.deepEqual((await dash()).body.streamers.find(s => s.id === streamer.id).accounts, [first.id], "the streamer's other account stays");
  r = await dash({ action: "assignAccount", accountId: other.id, streamers: [streamer.id] });
  assert.match(r.body.message, /now posts clips from/);
  assert.deepEqual((await dash()).body.streamers.find(s => s.id === streamer.id).accounts.sort(), [first.id, other.id].sort());
});

test("Local code writes post captions from the transcript ahead of posting; the owner's own text wins", async () => {
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
  const written = await clipRow(first.clip.id);
  assert.equal(written.caption_source, "local");
  assert.match(written.post_caption, /^No way he clutched that!/);
  assert.match(written.post_caption, /#fyp/);
  assert.doesNotMatch(written.post_caption, /outside/);
  const options={clipId:first.clip.id,topic:"",platform:"Instagram",tone:"Casual",length:"Short",emojis:false,hashtags:true};
  const draft=await fetch(base+"/api/captions",{method:"POST",headers:{...who,"content-type":"application/json"},body:JSON.stringify(options)});
  assert.equal(draft.status,200);
  const generated=await draft.json();assert.equal(generated.captions.length,3);
  assert.ok(generated.captions.every(c=>c.includes(owner)&&!c.includes("outside")));
  const other=await fetch(base+"/api/captions",{method:"POST",headers:{"oai-authenticated-user-id":"another-owner","oai-authenticated-user-email":"another@test.local","content-type":"application/json"},body:JSON.stringify(options)});
  assert.equal(other.status,404);
  assert.equal(await postedCaption(first.clip.id), written.post_caption, "the written caption is what posts");

  // 2. Text the owner saves is used as-is and never rewritten.
  const second = await addClip(streamer.id, material());
  const saved = await fetch(base + "/api/clips/" + second.clip.id + "/caption", { method: "POST", headers: { ...who, "content-type": "application/json" }, body: JSON.stringify({ action: "save", text: "My own words #mine" }) });
  assert.equal(saved.status, 200);
  assert.equal(await postedCaption(second.clip.id), "My own words #mine");
  const kept = await clipRow(second.clip.id);
  assert.deepEqual([kept.post_caption, kept.caption_source], ["My own words #mine", "edited"], "automatic generation never wrote over it");

  // 3. Rewrite on request replaces it.
  const rewrite = await fetch(base + "/api/clips/" + second.clip.id + "/caption", { method: "POST", headers: { ...who, "content-type": "application/json" }, body: JSON.stringify({ action: "write" }) });
  assert.equal(rewrite.status, 200);
  assert.equal((await rewrite.json()).source, "local");

  // 4. No transcript: posting uses the fallback and manual generation explains why.
  await dash({ action: "settings", settings: { ...settings, captionTemplate: "{streamer} fallback #test" } });
  const third = await addClip(streamer.id, {...material(),transcript:[]});
  assert.equal(await postedCaption(third.clip.id), owner + " fallback #test");
  assert.equal((await clipRow(third.clip.id)).post_caption, null);
  const missing=await fetch(base+"/api/clips/"+third.clip.id+"/caption",{method:"POST",headers:{...who,"content-type":"application/json"},body:JSON.stringify({action:"write"})});
  assert.equal(missing.status,409);

});

test("a new workspace reviews clips first, whether or not it has saved settings yet", async () => {
  // A second workspace, set up the way a newcomer does it: a channel and a PC, no settings saved.
  const other = { "oai-authenticated-user-id": owner + "_new", "oai-authenticated-user-email": owner + "_new@test.local" };
  const as = async body => { const r = await fetch(base + "/api/dashboard", body ? { method: "POST", headers: { ...other, "content-type": "application/json" }, body: JSON.stringify(body) } : { headers: other }); return { status: r.status, body: await r.json() }; };
  let channel;
  try {
    assert.equal((await as()).body.settings.mode, "review", "shown as Review first before anything is saved");
    assert.equal((await as({ action: "add", url: "https://twitch.tv/" + owner + "new" })).status, 200);
    channel = (await as()).body.streamers[0];
    const token = (await as({ action: "token" })).body.token;
    const bytes = randomBytes(3000), clip = { id: randomUUID(), streamerId: channel.id, createdAt: new Date().toISOString(), duration: 30, captions: true, sha: createHash("sha256").update(bytes).digest("hex"), size: bytes.length, reason: "chat" };
    assert.equal((await fetch(base + "/api/worker/clips", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify(clip) })).status, 200);
    assert.equal((await as()).body.clips.find(c => c.id === clip.id).review, "pending", "its PC's first clip waits for review");
    // Resuming automation creates the settings row: still Review first.
    assert.equal((await as({ action: "control", control: "running" })).status, 200);
    assert.equal((await as()).body.settings.mode, "review");
    await as({ action: "deleteClip", id: clip.id });
  } finally {
    if (channel) await as({ action: "remove", id: channel.id });
  }
});

test("This PC settings: saved choices reach the worker, which reports them applied with what it is doing", async () => {
  // Put back afterwards: later tests rely on the workspace settings set before this one.
  const was = (await dash()).body.settings;
  const restore = { mode: was.mode, duration: was.duration, dailyLimit: was.dailyLimit, captions: was.captions, framing: was.framing, destinations: was.destinations, aiCaptions: was.aiCaptions, ...(was.captionTemplate ? { captionTemplate: was.captionTemplate } : {}), ...(was.captionNotes ? { captionNotes: was.captionNotes } : {}), worker: {} };
  try {
  const prefs = { mode: "automatic", duration: 30, dailyLimit: 2, captions: true, framing: "blur", destinations: ["Instagram"], aiCaptions: false };
  assert.equal((await dash({ action: "settings", settings: { ...prefs, worker: { transcription: "accurate", maxCaptures: 2, power: "light" } } })).status, 200);
  const config = await (await worker("/api/worker/config")).json();
  assert.deepEqual(config.worker, { transcription: "accurate", maxCaptures: 2, power: "light" });
  assert.match(config.workerRev, /^[0-9a-z]+$/);
  let engine = (await dash()).body.engine;
  assert.equal(engine.settingsRev, config.workerRev, "the dashboard and the worker see the same fingerprint");
  assert.notEqual(engine.device?.applied, engine.settingsRev, "not applied until the worker says so");
  const device = { applied: config.workerRev, recording: [streamer.id], making: 1, waiting: 3, held: 0, uses: { maxCaptures: 2, clipWorkers: 1, whisperModel: "medium", aiWriter: true, retentionHours: 72 }, cores: 8, memoryGb: 15.7 };
  assert.equal((await worker("/api/worker/status", { method: "POST", body: JSON.stringify({ streamers: [], device }) })).status, 200);
  engine = (await dash()).body.engine;
  assert.equal(engine.device.applied, engine.settingsRev, "Applied");
  assert.deepEqual(engine.device.recording, [streamer.id]);
  assert.equal(engine.device.uses.whisperModel, "medium");
  assert.ok(engine.deviceAt);
  // A new choice changes the fingerprint: waiting for the PC again until it reports the new one.
  assert.equal((await dash({ action: "settings", settings: { ...prefs, worker: { transcription: "fast" } } })).status, 200);
  engine = (await dash()).body.engine;
  assert.notEqual(engine.device.applied, engine.settingsRev);
  assert.equal((await dash({ action: "settings", settings: { ...prefs, worker: { transcription: "perfect" } } })).status, 400, "unknown quality refused");
  assert.equal((await worker("/api/worker/status", { method: "POST", body: JSON.stringify({ streamers: [], device: { ...device, recording: ["not-an-id"] } }) })).status, 400, "a malformed report is refused");
  // An older worker that sends no device report still works.
  assert.equal((await worker("/api/worker/status", { method: "POST", body: JSON.stringify({ streamers: [] }) })).status, 200);
  } finally { assert.equal((await dash({ action: "settings", settings: restore })).status, 200, "settings restored"); }
});

test("This PC health: the worker's checks reach the dashboard, and a restart asked for there reaches the worker", async () => {
  const health = { checkedAt: new Date().toISOString(), diskFreeGb: 4.2, diskTotalGb: 475, ffmpeg: true, streamlink: true, whisper: true, whisperModel: "small", whisperReady: true, ollama: "down", ollamaMissing: [], codeChanged: true };
  const device = { applied: null, recording: [], making: 0, waiting: 0, held: 0, oldestWaitMin: 35, restartPending: false, uses: { maxCaptures: 1, clipWorkers: 1, whisperModel: "small", aiWriter: true, retentionHours: 72 }, cores: 8, memoryGb: 31.9, health };
  assert.equal((await worker("/api/worker/status", { method: "POST", body: JSON.stringify({ streamers: [], device }) })).status, 200);
  let engine = (await dash()).body.engine;
  assert.deepEqual(engine.device.health, health, "kept as reported");
  assert.equal(engine.device.oldestWaitMin, 35);
  assert.equal((await worker("/api/worker/status", { method: "POST", body: JSON.stringify({ streamers: [], device: { ...device, health: { ...health, ollama: "maybe" } } }) })).status, 400, "malformed health refused");
  // No restart asked for yet.
  assert.equal((await (await worker("/api/worker/config")).json()).restartAt, null);
  const asked = await dash({ action: "restartWorker" });
  assert.equal(asked.status, 200);
  const config = await (await worker("/api/worker/config")).json();
  assert.ok(Date.parse(config.restartAt) > Date.now() - 60_000, "the worker hears about it with its settings");
  engine = (await dash()).body.engine;
  assert.equal(engine.restartAt, config.restartAt);
  assert.equal((await worker("/api/worker/status", { method: "POST", body: JSON.stringify({ streamers: [], device: { ...device, restartPending: true } }) })).status, 200);
  assert.equal((await dash()).body.engine.device.restartPending, true);
});


test("Sign in with Twitch: closed to strangers, links to a signed-in workspace, then signs in alone and out", async () => {
  // Through Twitch and back: the start sets a state cookie; the callback needs it, the state and Twitch's code.
  const signIn = async (headers = {}, code = "good-code") => {
    const start = await fetch(base + "/api/auth/twitch/start?return_to=/", { redirect: "manual" });
    assert.equal(start.status, 302);
    const to = new URL(start.headers.get("location"));
    assert.equal(to.origin, fakeTwitch.url);
    assert.equal(to.searchParams.get("redirect_uri"), base + "/api/auth/twitch/callback");
    const state = to.searchParams.get("state"), cookie = start.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
    const back = await fetch(base + "/api/auth/twitch/callback?code=" + code + "&state=" + state, { headers: { ...headers, cookie }, redirect: "manual" });
    return { back, location: back.headers.get("location") ?? "", session: back.headers.getSetCookie().find(c => c.startsWith("cf_session=") && !c.startsWith("cf_session=;"))?.split(";")[0] ?? null };
  };
  // A forged state is refused.
  const start = await fetch(base + "/api/auth/twitch/start", { redirect: "manual" });
  const forged = await fetch(base + "/api/auth/twitch/callback?code=good-code&state=" + "a".repeat(64), { headers: { cookie: start.headers.getSetCookie()[0].split(";")[0] }, redirect: "manual" });
  assert.match(decodeURIComponent(forged.headers.get("location")), /expired/);
  // Sign-ups are closed by default: a stranger gets no workspace and no session.
  const stranger = await signIn();
  assert.equal(stranger.session, null);
  assert.match(decodeURIComponent(stranger.location), /isn't open for new sign-ups/);
  // Signed in another way (here the Sites headers, in production Cloudflare Access): Twitch is linked to this workspace.
  const linked = await signIn(who);
  assert.ok(linked.session, "a session cookie");
  assert.equal(linked.location, base + "/");
  assert.equal((await dash()).body.account.twitchLogin, "tester");
  // Later, with nothing but the Twitch session (no Access, no Sites headers): the same workspace.
  const alone = await signIn();
  const mine = await fetch(base + "/api/dashboard", { headers: { cookie: alone.session } });
  assert.equal(mine.status, 200);
  const body = await mine.json();
  assert.ok(body.streamers.some(s => s.id === streamer.id), "the workspace that was linked");
  assert.deepEqual(body.account, { twitch: true, twitchLogin: "tester", session: true });
  // A made-up cookie is signed out; Sign out ends the real one.
  assert.equal((await fetch(base + "/api/dashboard", { headers: { cookie: "cf_session=" + "b".repeat(64) } })).status, 401);
  const out = await fetch(base + "/api/auth/signout", { method: "POST", headers: { cookie: alone.session }, redirect: "manual" });
  assert.equal(out.status, 303);
  assert.equal((await fetch(base + "/api/dashboard", { headers: { cookie: alone.session } })).status, 401);
  assert.equal((await fetch(base + "/api/dashboard", { headers: { cookie: linked.session } })).status, 200, "other browsers stay signed in");
  // The worker download is for signed-in people only: signed out, it sends you to sign in; it's never a static file.
  const signedOut = await fetch(base + "/api/downloads/worker", { redirect: "manual" });
  assert.equal(signedOut.status, 302);
  assert.match(signedOut.headers.get("location"), /\/api\/auth\/twitch\/start$/);
  assert.notEqual((await fetch(base + "/api/downloads/worker", { headers: { cookie: linked.session }, redirect: "manual" })).status, 302, "signed in: the file (or that it isn't uploaded yet)");
  assert.equal((await fetch(base + "/downloads/clipflow-worker.zip", { redirect: "manual" })).status === 200, false, "no public copy");
});

test("Plans: a new workspace starts a trial, pays through Stripe, is held to its plan, and pauses when cancelled", async () => {
  const me = { "oai-authenticated-user-id": owner + "_bill", "oai-authenticated-user-email": owner + "_bill@test.local" };
  const as = async body => { const r = await fetch(base + "/api/dashboard", body ? { method: "POST", headers: { ...me, "content-type": "application/json" }, body: JSON.stringify(body) } : { headers: me }); return { status: r.status, body: await r.json() }; };
  const post = (path, body) => fetch(base + path, { method: "POST", headers: { ...me, "content-type": "application/json" }, body: JSON.stringify(body) });
  const webhook = (event, secret = "whsec_test") => { const payload = JSON.stringify(event), t = Math.floor(Date.now() / 1000); return fetch(base + "/api/stripe/webhook", { method: "POST", headers: { "stripe-signature": "t=" + t + ",v1=" + createHmac("sha256", secret).update(t + "." + payload).digest("hex") }, body: payload }); };
  let plan = (await as()).body.plan;
  assert.equal(plan.plan, "trial");
  assert.equal(plan.active, true);
  assert.ok(Date.parse(plan.trialEndsAt) > Date.now() + 13 * 86_400_000, "14 days");
  // Choose Streamer: Stripe Checkout, priced here, tied to this workspace.
  const checkout = await post("/api/billing/checkout", { plan: "streamer" });
  assert.equal(checkout.status, 200);
  assert.equal((await checkout.json()).url, "https://checkout.stripe.test/c");
  const asked = stripeAsked.at(-1);
  assert.equal(asked.auth, "Bearer sk_test_fake");
  assert.equal(asked.params.get("client_reference_id"), me["oai-authenticated-user-id"]);
  assert.equal(asked.params.get("line_items[0][price_data][unit_amount]"), "1200");
  assert.equal((await post("/api/billing/checkout", { plan: "gold" })).status, 400);
  assert.equal((await post("/api/billing/portal", {})).status, 409, "nothing to manage before paying");
  // Only Stripe's signed word counts.
  const paid = { type: "checkout.session.completed", data: { object: { mode: "subscription", client_reference_id: me["oai-authenticated-user-id"], customer: "cus_e2e", subscription: "sub_e2e", metadata: { plan: "streamer" } } } };
  assert.equal((await webhook(paid, "whsec_wrong")).status, 400);
  assert.equal((await as()).body.plan.plan, "trial");
  assert.equal((await webhook(paid)).status, 200);
  plan = (await as()).body.plan;
  assert.deepEqual({ plan: plan.plan, active: plan.active, canManage: plan.canManage, limits: plan.limits }, { plan: "streamer", active: true, canManage: true, limits: { channels: 1, accounts: 3 } });
  assert.equal((await (await post("/api/billing/portal", {})).json()).url, "https://billing.stripe.test/p");
  // Streamer covers one channel.
  assert.equal((await as({ action: "add", url: "https://twitch.tv/" + owner + "b1" })).status, 200);
  const second = await as({ action: "add", url: "https://twitch.tv/" + owner + "b2" });
  assert.equal(second.status, 402);
  assert.match(second.body.error, /covers 1 channel/);
  // Cancelled: the worker sees automation paused; the saved choice (running) is kept for when a plan is back.
  const token = (await as({ action: "token" })).body.token;
  const config = async () => (await (await fetch(base + "/api/worker/config", { headers: { authorization: "Bearer " + token } })).json()).control;
  assert.equal(await config(), "running");
  assert.equal((await webhook({ type: "customer.subscription.deleted", data: { object: { id: "sub_e2e", customer: "cus_e2e", status: "canceled", metadata: { owner: me["oai-authenticated-user-id"], plan: "streamer" } } } })).status, 200);
  assert.equal((await as()).body.plan.active, false);
  assert.equal(await config(), "paused");
  // An event for some other, older subscription doesn't change it back.
  await webhook({ type: "customer.subscription.updated", data: { object: { id: "sub_old", customer: "cus_e2e", status: "past_due", metadata: { owner: me["oai-authenticated-user-id"], plan: "agency" } } } });
  assert.equal((await as()).body.plan.status, "canceled");
  for (const s of (await as()).body.streamers) await as({ action: "remove", id: s.id });
});

test("an account set to Spanish posts the Spanish version the worker made, or fails with the reason", async () => {
  const words = [[6.2, 6.6, "No"], [6.7, 7.0, "way"], [7.1, 8.6, "that!"]];
  const material = () => { const src = randomBytes(2048); return { edit: defaultEdit(defaultStyle(), { trimStart: 6, trimEnd: 36 }), transcript: words, source: { width: 1920, height: 1080, duration: 42, sha: createHash("sha256").update(src).digest("hex"), size: src.length } }; };
  // One account, so each clip goes to one platform download per publisher run. (The local test Worker doesn't answer a
  // second download made while the same run is still waiting on the first; real platforms aren't affected.)
  const { body: before } = await dash(), links = before.streamers.find(s => s.id === streamer.id).accounts;
  const accounts = before.accounts.filter(a => a.id === links[0]);
  assert.equal((await dash({ action: "assign", streamerId: streamer.id, accounts: [links[0]] })).status, 200);
  for (const a of accounts) assert.equal((await dash({ action: "accountOptions", id: a.id, options: { subtitleLanguage: "es" } })).status, 200);
  const sendVersion = async (id, rev, bytes, caption) => worker("/api/worker/clips/" + id + "/translation", { method: "PUT", body: bytes, headers: { "content-type": "video/mp4", "x-lang": "es", "x-rev": String(rev), "x-clip-sha256": createHash("sha256").update(bytes).digest("hex"), "x-caption": encodeURIComponent(caption) } });
  try {
    // 1. The post waits while the worker makes the Spanish version; the worker is told what to translate. (It posts
    // to more than one account, each sending one post at a time: any of its posts that gets its turn asks.)
    const { clip } = await addClip(streamer.id, material());
    let waiting;
    for (let i = 0; i < 40 && !waiting; i++) { await cron(130_000); waiting = (await posts()).find(p => p.clip_id === clip.id && p.error); }
    assert.ok(waiting, "never reached: " + JSON.stringify((await posts()).map(p => [p.clip_id === clip.id, p.state, p.error])));
    assert.equal(waiting.state, "queued");
    assert.match(waiting.error, /Spanish version/);
    const asked = (await (await worker("/api/worker/config")).json()).translations.find(t => t.id === clip.id);
    assert.equal(asked.lang, "es");
    assert.ok(asked.edit && Array.isArray(asked.words) && typeof asked.caption === "string", "the edit, transcript and English caption to translate");
    assert.ok(!(await fakeLog()).containers.some(([, c]) => c.videoUrl.includes(clip.id)), "nothing posted in English meanwhile");
    // 2. The worker's upload: a stale revision refused, then the right one; the post goes out with it.
    const spanish = randomBytes(5000);
    assert.equal((await sendVersion(clip.id, asked.rev + 1, spanish, "x")).status, 409);
    assert.equal((await sendVersion(clip.id, asked.rev, spanish, "¡No puede ser! #test")).status, 200);
    // From here the local test Worker answers the cron request late (its work is done in under a second), so the
    // publisher runs are started without waiting on that answer and the result is read from the fake platform.
    const kick = async () => { clock += 130_000; fetch(base + "/__test/cron?time=" + clock, { signal: AbortSignal.timeout(20_000) }).catch(() => {}); await sleep(15_000); };
    let container;
    for (let i = 0; i < 6 && !container; i++) { await kick(); container = (await fakeLog()).containers.find(([, c]) => c.videoUrl.includes(clip.id))?.[1]; }
    assert.ok(container, "posted once the version was ready");
    assert.match(container.videoUrl, new RegExp("/media/" + clip.id + "-es\\.mp4\\?e=\\d+&s="));
    assert.equal(container.fetchStatus, 200, "the platform could download the Spanish file");
    assert.equal(container.bytes, spanish.length);
    assert.equal(container.caption, "¡No puede ser! #test");
    // 3. A version the worker couldn't make fails the post with the reason, rather than posting English.
    const second = await addClip(streamer.id, material());
    let ask;
    for (let i = 0; i < 10 && !ask; i++) { await kick(); ask = (await (await worker("/api/worker/config")).json()).translations.find(t => t.id === second.clip.id); }
    assert.ok(ask, "the second clip's version was asked for");
    assert.equal((await worker("/api/worker/clips/" + second.clip.id + "/translation", { method: "POST", body: JSON.stringify({ lang: "es", rev: ask.rev, error: "Ollama is not running" }) })).status, 200);
    let failed;
    for (let i = 0; i < 6 && !failed; i++) { await kick(); failed = (await posts()).find(p => p.clip_id === second.clip.id && p.state === "failed"); }
    assert.ok(failed, "a post of the clip failed: " + JSON.stringify((await posts()).filter(p => p.clip_id === second.clip.id).map(p => [p.state, p.error])));
    assert.match(failed.error, /Couldn't make the Spanish version: Ollama is not running/);
    assert.ok(!(await fakeLog()).containers.some(([, c]) => c.videoUrl.includes(second.clip.id)), "nothing posted in English");
    // 4. Retrying the post asks the worker for the version again.
    assert.equal((await dash({ action: "retryPost", id: failed.id })).status, 200);
    let again;
    for (let i = 0; i < 6 && !again; i++) { await kick(); again = (await (await worker("/api/worker/config")).json()).translations.find(t => t.id === second.clip.id); }
    assert.ok(again, "asked again after Retry");
  } finally {
    for (const a of accounts) await dash({ action: "accountOptions", id: a.id, options: { subtitleLanguage: "en" } });
    await dash({ action: "assign", streamerId: streamer.id, accounts: links });
  }
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

test("editable sources older than 10 days are removed once a day; the finished clip stays", async () => {
  const withSource = async createdAt => {
    const src = randomBytes(3000), edit = defaultEdit(defaultStyle(), { trimStart: 2, trimEnd: 32 });
    const { clip } = await addClip(streamer.id, { createdAt, edit, transcript: [], source: { width: 1920, height: 1080, duration: 40, sha: createHash("sha256").update(src).digest("hex"), size: src.length } });
    assert.equal((await worker("/api/worker/clips/" + clip.id + "/source", { method: "PUT", headers: { "content-type": "video/mp4" }, body: src })).status, 200);
    return clip;
  };
  const day = 86_400_000;
  // The next run is a day on (earlier runs already did today's cleanup).
  const old = await withSource(new Date(clock + day - 20 * day).toISOString()), recent = await withSource(new Date(clock + day - 2 * day).toISOString());
  const opened = async id => (await fetch(base + "/api/clips/" + id + "/edit", { headers: who })).json();
  assert.equal((await opened(old.id)).sourceStored, true);
  await cron(day);
  const gone = await opened(old.id), kept = await opened(recent.id);
  assert.equal(gone.sourceStored, false, "the old clip's source was removed");
  assert.match(gone.pruned ?? "", /^\d{4}-\d{2}-\d{2}$/, "the editor is told when");
  assert.equal(kept.sourceStored, true, "a two-day-old clip keeps its source");
  assert.equal((await fetch(base + "/api/clips/" + old.id + "/source", { headers: who })).status, 404, "nothing left in storage");
  assert.equal((await fetch(base + "/api/clips/" + old.id + "/file", { headers: who })).status, 200, "the finished clip is still there");
  const save = await fetch(base + "/api/clips/" + old.id + "/edit", { method: "POST", headers: { ...who, "content-type": "application/json" }, body: JSON.stringify({ edit: gone.edit, rev: gone.rev }) });
  assert.equal(save.status, 409, "it can't be re-edited");
  assert.match((await save.json()).error, /removed to save storage/);
  // The worker can't put it back either.
  assert.equal((await worker("/api/worker/clips/" + old.id + "/source", { method: "PUT", headers: { "content-type": "video/mp4" }, body: randomBytes(3000) })).status, 409);
});

test("disconnecting removes the account and its links, and drops unsent posts", async () => {
  for (const a of (await dash()).body.accounts) assert.equal((await dash({ action: "disconnect", id: a.id })).status, 200);
  const { body } = await dash();
  assert.equal(body.accounts.length, 0);
  assert.ok(body.streamers.every(s => s.accounts.length === 0));
  assert.ok(body.posts.every(p => p.state === "published"), "only published history is kept");
});


test("recording uploads keep parts private, queue only complete files and clean up", async () => {
  const url=base+"/api/recording-uploads";
  const start=body=>fetch(url,{method:"POST",headers:{...who,"content-type":"application/json"},body:JSON.stringify(body)});
  const bytes=Buffer.alloc(16*1024*1024+17,7);bytes.write("ftyp",4);
  const options={name:"my recording.mp4",size:bytes.length,streamerId:streamer.id,count:3};
  assert.equal((await fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(options)})).status,401);
  assert.equal((await start({...options,size:2*1024**3+1})).status,400);
  assert.equal((await start({...options,name:"not-video.exe"})).status,400);
  assert.equal((await start({...options,streamerId:randomUUID()})).status,404);
  const created=await start(options);assert.equal(created.status,200);
  const {id,partSize}=await created.json(),endpoint=url+"/"+id;
  const put=async(part,body,identity=who)=>{
    // A rejected body may close the local runtime socket; don't reuse it for the next test request.
    const response=await fetch(endpoint,{method:"PUT",headers:{...identity,"x-part":String(part),"content-type":"application/octet-stream","connection":"close"},body});
    return new Response(await response.text(),{status:response.status});
  };
  try{
    const outOfOrder=await put(2,bytes.subarray(partSize));assert.equal(outOfOrder.status,400,await outOfOrder.text());
    assert.equal((await put(1,Buffer.from("private"),{"oai-authenticated-user-id":"another-user","oai-authenticated-user-email":"another@test.local"})).status,404);
    assert.equal((await put(1,Buffer.from("short"))).status,400);
    assert.equal((await fetch(endpoint,{method:"POST",headers:who})).status,409);
    assert.ok(!(await (await worker("/api/worker/config")).json()).uploads.some(x=>x.id===id));
    assert.equal((await worker("/api/worker/recordings/"+id+"/source")).status,404);
    assert.equal((await put(1,Buffer.alloc(partSize,0))).status,415,"reject non-video containers");
    assert.equal((await put(1,bytes.subarray(0,partSize))).status,200);
    assert.equal((await put(1,bytes.subarray(0,partSize))).status,200,"part retries are idempotent");
    assert.equal((await put(2,bytes.subarray(partSize))).status,200);
    assert.equal((await fetch(endpoint,{method:"POST",headers:who})).status,200);
    assert.equal((await fetch(endpoint,{method:"POST",headers:who})).status,200,"completion retries are idempotent");
    const config=await (await worker("/api/worker/config")).json();
    assert.ok(config.uploads.some(x=>x.id===id&&x.streamerId===streamer.id));
    assert.ok(!config.imports.some(x=>x.id===id),"old workers never receive an invalid URL");
    const dashboard=(await dash()).body;
    assert.equal(dashboard.recordings.find(r=>r.id===id).title,options.name);
    assert.equal(dashboard.recordingRequests.filter(q=>q.recording_id===id).length,1);
    const download=await worker("/api/worker/recordings/"+id+"/source");assert.equal(download.status,200);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()),bytes);
    assert.equal((await fetch(base+"/api/worker/recordings/"+id+"/source")).status,401);
    assert.equal((await dash({action:"deleteRecording",id})).status,200);
    assert.equal((await worker("/api/worker/recordings/"+id+"/source")).status,404);
    assert.equal((await fetch(endpoint,{method:"POST",headers:who})).status,404);
  }finally{await dash({action:"deleteRecording",id}).catch(()=>{});await fetch(endpoint,{method:"DELETE",headers:who});}
  const cancelled=await (await start({...options,size:100,count:0})).json();
  assert.equal((await fetch(url+"/"+cancelled.id,{method:"DELETE",headers:who})).status,200);
  assert.equal((await fetch(url+"/"+cancelled.id,{method:"POST",headers:who})).status,404);
});

test("a pairing code gives a PC a worker token once, and replaces the earlier token", async () => {
  // Its own workspace, so the token the other tests use isn't replaced.
  const other = { "oai-authenticated-user-id": owner + "_pair", "oai-authenticated-user-email": owner + "_pair@test.local" };
  const as = async body => { const r = await fetch(base + "/api/dashboard", { method: "POST", headers: { ...other, "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  const redeem = code => fetch(base + "/api/worker/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
  const config = token => fetch(base + "/api/worker/config", { headers: { authorization: "Bearer " + token } });
  const old = (await as({ action: "token" })).body.token;
  assert.equal((await config(old)).status, 200);
  const first = (await as({ action: "pairCode" })).body;
  assert.match(first.pairCode, /^[2-9A-Z]{4}-[2-9A-Z]{4}$/);
  assert.ok(Date.parse(first.pairExpires) > Date.now() + 9 * 60_000, "valid for about 10 minutes");
  // A newer code replaces it.
  const second = (await as({ action: "pairCode" })).body;
  assert.equal((await redeem(first.pairCode)).status, 400, "the replaced code no longer works");
  assert.equal((await redeem("2222-2222")).status, 400);
  assert.equal((await redeem("not a code")).status, 400);
  // Typed any way: lower case, without the dash.
  const paired = await redeem(second.pairCode.toLowerCase().replace("-", ""));
  assert.equal(paired.status, 200);
  const { token, url } = await paired.json();
  assert.match(token, /^cfw_[0-9a-f]{64}$/);
  assert.equal(url, base);
  assert.equal((await config(token)).status, 200, "the new token works");
  assert.equal((await config(old)).status, 401, "the earlier token is revoked");
  assert.equal((await redeem(second.pairCode)).status, 400, "a code works once");
});
