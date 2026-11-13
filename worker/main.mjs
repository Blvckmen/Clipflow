import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Store, allowed, channelUrl, dueForProbe, plan, retryDelay, validateControl } from "./core.mjs";
import { chatSpike, perSecond } from "./highlights.mjs";
import { openChat } from "./chat.mjs";
import { probeLive, processWindow, streamlink } from "./media.mjs";
import { Recorder } from "./recorder.mjs";

const env = process.env;
const seconds = (value, fallback) => { const n = Number(value ?? fallback); if (!Number.isFinite(n) || n <= 0) throw new Error("Invalid numeric setting: " + value); return n * 1000; };
const token = env.CLIPFLOW_TOKEN ?? "";
let origin;
try { origin = new URL(env.CLIPFLOW_URL ?? ""); } catch { /* reported below */ }
if (!origin || !/^cfw_[0-9a-f]{64}$/.test(token)) { console.error("Set CLIPFLOW_URL to the dashboard origin and CLIPFLOW_TOKEN to a token from Connect worker."); process.exit(1); }
if (origin.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(origin.hostname)) { console.error("CLIPFLOW_URL must use https."); process.exit(1); }

const dataDir = env.DATA_DIR || "/data";
const pollMs = seconds(env.POLL_SECONDS, 60), retentionMs = seconds(env.RETENTION_HOURS, 72) * 3600;
// Without a chat spike, a streamer gets one "loudest recent moment" clip per COOLDOWN_SECONDS.
const fallbackMs = seconds(env.COOLDOWN_SECONDS, 600), chatGapMs = seconds(env.CHAT_CLIP_GAP_SECONDS, 120);
const bufferSeconds = seconds(env.BUFFER_SECONDS, 240) / 1000, spikeFactor = Number(env.CHAT_SPIKE_FACTOR ?? 2.5);
const maxSessions = Math.max(1, Math.floor(Number(env.MAX_CAPTURES ?? 1)));
const liveCheckMs = seconds(env.LIVE_CHECK_SECONDS, 120), probeConcurrency = 3, probesPerCycle = 15;
const postRollMs = 20_000;
// Why a clip was cut; the code is sent to the dashboard with the clip.
const reasonLabel = { chat: "chat spike", audio: "loudest moment" };
const store = new Store(dataDir);
// streamer id -> { streamer, recorder, chat, startedMs, lastClipMs, pending: { atMs, reason } | null, busy }
const sessions = new Map(), blockedUntil = new Map(), failures = new Map();
// streamer id -> { status: live|recording|offline|error, checkedAt (ms), title }; `unreported` holds ids changed since the last status post.
const live = new Map(), unreported = new Set();
const jobs = [];  // extracted windows waiting for CPU-heavy processing, handled one at a time
let config = null, stopping = false, timer, sessionTimer, processing = null;
let pendingError = null;  // latest problem not yet delivered to the dashboard

// Logs a problem and queues it for the dashboard, which shows the most recent one.
function problem(message) {
  const text = String(message).replace(/\s+/g, " ").trim().slice(0, 500);
  console.warn(text);
  pendingError = { message: text, at: new Date().toISOString() };
}

// Redirects are refused so a sign-in wall in front of the dashboard surfaces as an error, not a silent HTML page.
function api(path, { timeout = 20_000, headers = {}, ...init } = {}) {
  return fetch(new URL(path, origin), { ...init, redirect: "error", signal: AbortSignal.timeout(timeout), headers: { authorization: "Bearer " + token, "content-type": "application/json", ...headers } });
}

function setLive(id, status, title = null) {
  live.set(id, { status, checkedAt: Date.now(), title });
  unreported.add(id);
}
const isLive = id => { const s = live.get(id); return s?.status === "live" && Date.now() - s.checkedAt <= liveCheckMs * 2; };
const nextUtcMidnight = () => { const d = new Date(); d.setUTCHours(24, 0, 0, 0); return d.getTime(); };

async function probe(streamers) {
  const queue = [...streamers];
  await Promise.all(Array.from({ length: Math.min(probeConcurrency, queue.length) }, async () => {
    for (let s; (s = queue.shift()) && !stopping;) {
      const result = await probeLive(s.url, AbortSignal.timeout(60_000)).catch(error => ({ status: "error", title: null, message: error.message }));
      const before = live.get(s.id)?.status;
      setLive(s.id, result.status, result.title);
      if (result.status === "error") problem("Live check failed for " + s.url + ": " + result.message);
      else if (before !== result.status) console.log("Live check:", s.url, "is", result.status + (result.title ? " (" + result.title + ")" : ""));
    }
  }));
}

async function reportStatus() {
  // Recording streamers are refreshed every cycle so the dashboard never shows them as stale.
  for (const id of sessions.keys()) setLive(id, "recording", live.get(id)?.title ?? null);
  if (!unreported.size && !pendingError) return;
  const ids = [...unreported], error = pendingError;
  const streamers = ids.filter(id => live.has(id)).map(id => { const s = live.get(id); return { id, status: s.status, checkedAt: new Date(s.checkedAt).toISOString(), title: s.title }; });
  try {
    const response = await api("/api/worker/status", { method: "POST", body: JSON.stringify({ streamers, ...(error && { error }) }) });
    if (!response.ok) throw new Error("HTTP " + response.status);
    for (const id of ids) unreported.delete(id);
    if (pendingError === error) pendingError = null;
  } catch (failure) { console.warn("Status report deferred:", failure.message); }
}

async function refresh() {
  try {
    const response = await api("/api/worker/config");
    if (!response.ok) throw new Error("HTTP " + response.status);
    config = validateControl(await response.json());
  } catch (error) {
    if (config) console.warn("Config unavailable; stopping recordings:", error.message);
    else console.warn("Config unavailable:", error.message);
    config = null;
  }
}

async function startSession(streamer) {
  const recorder = new Recorder(channelUrl(streamer.url), join(dataDir, "buffer", streamer.id), { bufferSeconds, streamlink });
  const session = { streamer, recorder, chat: null, startedMs: Date.now(), lastClipMs: Date.now(), pending: null, busy: false };
  sessions.set(streamer.id, session);
  try { await recorder.start(); }
  catch (error) { sessions.delete(streamer.id); problem("Could not start recording " + streamer.url + ": " + error.message); return; }
  session.chat = openChat(streamer.url);
  setLive(streamer.id, "recording", live.get(streamer.id)?.title ?? null);
  console.log("Recording", streamer.url, session.chat ? "(watching chat)" : "(audio only)");
}

async function stopSession(id, reason) {
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);
  session.chat?.close();
  const failure = session.recorder.error;
  await session.recorder.stop();
  if (failure) problem("Recording " + session.streamer.url + " failed: " + failure);
  else console.log("Stopped recording", session.streamer.url + ":", reason);
}

// Copies the buffered window out immediately (the buffer moves on), then queues the slow processing.
async function clipWindow(session, fromMs, toMs, reason) {
  const { streamer } = session, settings = config;
  const id = crypto.randomUUID(), dir = join(dataDir, "clips", streamer.id, id), raw = join(dir, "window.m2t");
  session.busy = true;
  try {
    store.add(id, streamer.id, join(dir, "clip.mp4"), settings.duration, settings.captions, reason);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const rawStartMs = await session.recorder.extract(fromMs, toMs, raw, AbortSignal.timeout(60_000));
    const length = (toMs - rawStartMs) / 1000 + 10;
    jobs.push({ id, dir, raw, streamer, settings, reason, chat: session.chat ? perSecond(session.chat.times, rawStartMs, length) : [], focusFrom: (fromMs - rawStartMs) / 1000, focusTo: (toMs - rawStartMs) / 1000 });
    void processJobs();
  } catch (error) {
    store.fail(id);
    await rm(dir, { recursive: true, force: true });
    problem("Could not cut a clip window for " + streamer.url + ": " + error.message);
  } finally { session.busy = false; }
}

async function processJobs() {
  if (processing) return;
  while (jobs.length && !stopping) {
    const job = jobs.shift();
    if (!allowed(config, job.streamer.id)) { store.fail(job.id); await rm(job.dir, { recursive: true, force: true }); continue; }
    const controller = new AbortController();
    processing = { job, controller };
    try {
      const result = await processWindow(job.raw, { settings: job.settings, focusFrom: job.focusFrom, focusTo: job.focusTo, chat: job.chat }, join(job.dir, "clip.mp4"), controller.signal);
      store.ready(job.id, result.sha, Math.min(90, Math.max(15, Math.round(result.end - result.start))));
      console.log("Clip ready", job.id, "from", job.streamer.url, "(" + reasonLabel[job.reason] + ", " + Math.round(result.end - result.start) + "s)");
    } catch (error) {
      store.fail(job.id);
      await rm(job.dir, { recursive: true, force: true });
      if (!controller.signal.aborted) problem("Clip processing failed for " + job.streamer.url + ": " + error.message);
    } finally { processing = null; }
    void report();
  }
}

// Runs every few seconds: ends sessions that should stop and turns chat spikes or quiet periods into clips.
async function checkSessions() {
  const now = Date.now();
  if (processing && !allowed(config, processing.job.streamer.id)) processing.controller.abort();
  for (const [id, session] of sessions) {
    const settings = config, name = session.streamer.url;
    if (!allowed(settings, id)) { await stopSession(id, "paused, stopped or disabled"); continue; }
    if (session.recorder.ended) {
      const attempt = failures.get(id) ?? 0;
      failures.set(id, attempt + 1);
      blockedUntil.set(id, now + retryDelay(attempt));
      live.delete(id);  // re-check before recording again
      await stopSession(id, "stream ended or recording failed");
      continue;
    }
    if (store.countToday(id) >= settings.dailyLimit) { blockedUntil.set(id, nextUtcMidnight()); await stopSession(id, "daily clip limit reached"); continue; }
    if (session.recorder.buffered() > 30) failures.delete(id);
    if (session.busy) continue;
    const latest = session.recorder.latestMs(), preRollMs = Math.max(45, settings.duration + 15) * 1000;
    if (session.pending) {
      if (latest >= session.pending.atMs + postRollMs) {
        const { atMs, reason } = session.pending;
        session.pending = null; session.lastClipMs = now;
        void clipWindow(session, atMs - preRollMs, atMs + postRollMs, reason);
      }
      continue;
    }
    if (session.chat && now - session.lastClipMs >= chatGapMs) {
      const spike = chatSpike(session.chat.times, now, { sinceMs: Math.max(session.chat.since, session.startedMs), factor: spikeFactor });
      if (spike.spike) {
        console.log("Chat spike on", name + ":", spike.recent, "messages in 10s vs typical", spike.baseline);
        session.pending = { atMs: now, reason: "chat" };
        continue;
      }
    }
    const lookbackS = Math.min(bufferSeconds - 20, Math.max(90, settings.duration * 2));
    if (now - session.lastClipMs >= fallbackMs && session.recorder.buffered() >= lookbackS) {
      session.lastClipMs = now;
      void clipWindow(session, latest - lookbackS * 1000, latest, "audio");
    }
  }
}

async function report() {
  for (const row of store.pending()) {
    let size;
    try { size = (await stat(row.path)).size; } catch { store.fail(row.id); continue; }
    try {
      const permanent = status => status >= 400 && status < 500 && status !== 401 && status !== 429;
      const response = await api("/api/worker/clips", { method: "POST", body: JSON.stringify({ id: row.id, streamerId: row.streamer, createdAt: row.created_at, duration: row.duration, captions: !!row.captions, sha: row.sha, size, ...(row.reason && { reason: row.reason }) }) });
      // 4xx other than auth and rate limiting will not succeed on retry (for example a removed streamer).
      if (permanent(response.status)) { store.rejected(row.id); problem("Dashboard refused clip " + row.id + " (HTTP " + response.status + ")"); continue; }
      if (!response.ok) throw new Error("HTTP " + response.status);
      // Both steps are idempotent server-side, so a retry after a failed upload safely repeats the report.
      const upload = await api("/api/worker/clips/" + row.id + "/file", { method: "PUT", body: await readFile(row.path), headers: { "content-type": "video/mp4" }, timeout: 180_000 });
      if (upload.status === 501) { store.uploaded(row.id); console.log("Clip reported; dashboard storage is off, file kept locally:", row.id); }
      else if (upload.ok) { store.uploaded(row.id); console.log("Clip uploaded:", row.id); }
      else if (permanent(upload.status)) { store.rejected(row.id); problem("Dashboard refused the file for clip " + row.id + " (HTTP " + upload.status + ")"); }
      else throw new Error("upload HTTP " + upload.status);
    } catch (error) {
      store.retry(row.id, row.attempts + 1);
      problem("Could not send clip " + row.id + " to the dashboard, will retry: " + error.message);
    }
  }
}

async function prune() {
  const cutoff = new Date(Date.now() - retentionMs).toISOString();
  for (const row of store.old(cutoff)) {
    await rm(dirname(row.path), { recursive: true, force: true });
    store.remove(row.id);
  }
}

async function tick() {
  await refresh();
  // Stop disallowed recordings before the (slow) live checks rather than after them.
  for (const id of sessions.keys()) if (!allowed(config, id)) await stopSession(id, "paused, stopped or disabled");
  await probe(dueForProbe(config, live, { running: new Set(sessions.keys()), now: Date.now(), interval: liveCheckMs, limit: probesPerCycle }));
  const { start } = plan(config, { running: new Set(sessions.keys()), blockedUntil, countToday: id => store.countToday(id), now: Date.now(), maxCaptures: maxSessions, isLive });
  for (const streamer of start) await startSession(streamer);
  await reportStatus();
  await report();
  await prune();
}

async function loop() {
  if (stopping) return;
  try { await tick(); } catch (error) { console.error("Worker cycle failed:", error); }
  if (!stopping) timer = setTimeout(loop, pollMs);
}

async function shutdown() {
  if (stopping) return;
  stopping = true; clearTimeout(timer); clearInterval(sessionTimer);
  setTimeout(() => process.exit(1), 15_000).unref();
  processing?.controller.abort();
  await Promise.all([...sessions.keys()].map(id => stopSession(id, "worker shutting down")));
  store.close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
console.log("Clipflow worker polling", origin.origin, "every", pollMs / 1000, "seconds");
let checking = false;
sessionTimer = setInterval(() => {
  if (stopping || checking) return;
  checking = true;
  checkSessions().catch(error => console.error("Session check failed:", error)).finally(() => { checking = false; });
}, 5_000);
void loop();
