import { readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Store, allowed, dueForProbe, plan, retryDelay, validateControl } from "./core.mjs";
import { captureClip, probeLive } from "./media.mjs";

const env = process.env;
const seconds = (value, fallback) => { const n = Number(value ?? fallback); if (!Number.isFinite(n) || n <= 0) throw new Error("Invalid numeric setting: " + value); return n * 1000; };
const token = env.CLIPFLOW_TOKEN ?? "";
let origin;
try { origin = new URL(env.CLIPFLOW_URL ?? ""); } catch { /* reported below */ }
if (!origin || !/^cfw_[0-9a-f]{64}$/.test(token)) { console.error("Set CLIPFLOW_URL to the dashboard origin and CLIPFLOW_TOKEN to a token from Connect worker."); process.exit(1); }
if (origin.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(origin.hostname)) { console.error("CLIPFLOW_URL must use https."); process.exit(1); }

const dataDir = env.DATA_DIR || "/data";
const pollMs = seconds(env.POLL_SECONDS, 60), cooldownMs = seconds(env.COOLDOWN_SECONDS, 600), retentionMs = seconds(env.RETENTION_HOURS, 72) * 3600;
const maxCaptures = Math.max(1, Math.floor(Number(env.MAX_CAPTURES ?? 1)));
const liveCheckMs = seconds(env.LIVE_CHECK_SECONDS, 120), probeConcurrency = 3, probesPerCycle = 15;
const store = new Store(dataDir);
const running = new Map(), blockedUntil = new Map(), failures = new Map();
// streamer id -> { status: live|recording|offline|error, checkedAt (ms), title }; `unreported` holds ids changed since the last status post.
const live = new Map(), unreported = new Set();
let config = null, stopping = false, timer;

// Redirects are refused so a sign-in wall in front of the dashboard surfaces as an error, not a silent HTML page.
function api(path, { timeout = 20_000, headers = {}, ...init } = {}) {
  return fetch(new URL(path, origin), { ...init, redirect: "error", signal: AbortSignal.timeout(timeout), headers: { authorization: "Bearer " + token, "content-type": "application/json", ...headers } });
}

function setLive(id, status, title = null) {
  live.set(id, { status, checkedAt: Date.now(), title });
  unreported.add(id);
}
const isLive = id => { const s = live.get(id); return s?.status === "live" && Date.now() - s.checkedAt <= liveCheckMs * 2; };

async function probe(streamers) {
  const queue = [...streamers];
  await Promise.all(Array.from({ length: Math.min(probeConcurrency, queue.length) }, async () => {
    for (let s; (s = queue.shift()) && !stopping;) {
      const result = await probeLive(s.url, AbortSignal.timeout(60_000)).catch(() => ({ status: "error", title: null }));
      const before = live.get(s.id)?.status;
      setLive(s.id, result.status, result.title);
      if (before !== result.status) console.log("Live check:", s.url, "is", result.status + (result.title ? " (" + result.title + ")" : ""));
    }
  }));
}

async function reportStatus() {
  // Recording streamers are refreshed every cycle so the dashboard never shows them as stale.
  for (const id of running.keys()) setLive(id, "recording", live.get(id)?.title ?? null);
  if (!unreported.size) return;
  const ids = [...unreported];
  const streamers = ids.filter(id => live.has(id)).map(id => { const s = live.get(id); return { id, status: s.status, checkedAt: new Date(s.checkedAt).toISOString(), title: s.title }; });
  try {
    const response = await api("/api/worker/status", { method: "POST", body: JSON.stringify({ streamers }) });
    if (!response.ok) throw new Error("HTTP " + response.status);
    for (const id of ids) unreported.delete(id);
  } catch (error) { console.warn("Status report deferred:", error.message); }
}

async function refresh() {
  try {
    const response = await api("/api/worker/config");
    if (!response.ok) throw new Error("HTTP " + response.status);
    config = validateControl(await response.json());
  } catch (error) {
    if (config) console.warn("Config unavailable; cancelling captures:", error.message);
    else console.warn("Config unavailable:", error.message);
    config = null;
  }
}

async function capture(streamer, settings) {
  const controller = new AbortController();
  running.set(streamer.id, controller);
  const id = crypto.randomUUID(), dir = join(dataDir, "clips", streamer.id, id), file = join(dir, "clip.mp4");
  store.add(id, streamer.id, file, settings.duration, settings.captions);
  const title = live.get(streamer.id)?.title ?? null;
  setLive(streamer.id, "recording", title);
  try {
    store.ready(id, await captureClip(streamer, settings, file, controller.signal));
    failures.delete(streamer.id);
    blockedUntil.set(streamer.id, Date.now() + cooldownMs);
    setLive(streamer.id, "live", title);
    console.log("Captured clip", id, "from", streamer.url);
  } catch (error) {
    store.fail(id);
    await rm(dir, { recursive: true, force: true });
    const attempt = failures.get(streamer.id) ?? 0;
    failures.set(streamer.id, attempt + 1);
    blockedUntil.set(streamer.id, Date.now() + retryDelay(attempt));
    // Most capture failures mean the stream ended; drop the stale "live" so the next cycle re-checks it.
    live.delete(streamer.id);
    if (!controller.signal.aborted) console.warn("Capture failed for", streamer.url + ":", error.message);
  } finally {
    running.delete(streamer.id);
  }
}

async function report() {
  for (const row of store.pending()) {
    let size;
    try { size = (await stat(row.path)).size; } catch { store.fail(row.id); continue; }
    try {
      const permanent = status => status >= 400 && status < 500 && status !== 401 && status !== 429;
      const response = await api("/api/worker/clips", { method: "POST", body: JSON.stringify({ id: row.id, streamerId: row.streamer, createdAt: row.created_at, duration: row.duration, captions: !!row.captions, sha: row.sha, size }) });
      // 4xx other than auth and rate limiting will not succeed on retry (for example a removed streamer).
      if (permanent(response.status)) { store.rejected(row.id); console.warn("Clip report rejected:", row.id, response.status); continue; }
      if (!response.ok) throw new Error("HTTP " + response.status);
      // Both steps are idempotent server-side, so a retry after a failed upload safely repeats the report.
      const upload = await api("/api/worker/clips/" + row.id + "/file", { method: "PUT", body: await readFile(row.path), headers: { "content-type": "video/mp4" }, timeout: 180_000 });
      if (upload.status === 501) { store.uploaded(row.id); console.log("Clip reported; dashboard storage is off, file kept locally:", row.id); }
      else if (upload.ok) { store.uploaded(row.id); console.log("Clip uploaded:", row.id); }
      else if (permanent(upload.status)) { store.rejected(row.id); console.warn("Clip upload rejected:", row.id, upload.status); }
      else throw new Error("upload HTTP " + upload.status);
    } catch (error) {
      store.retry(row.id, row.attempts + 1);
      console.warn("Clip report deferred:", row.id, error.message);
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
  // Cancel disallowed captures before the (slow) live checks rather than after them.
  for (const [id, controller] of running) if (!allowed(config, id)) controller.abort();
  await probe(dueForProbe(config, live, { running: new Set(running.keys()), now: Date.now(), interval: liveCheckMs, limit: probesPerCycle }));
  const { start, stop } = plan(config, { running: new Set(running.keys()), blockedUntil, countToday: id => store.countToday(id), now: Date.now(), maxCaptures, isLive });
  for (const id of stop) running.get(id)?.abort();
  for (const streamer of start) void capture(streamer, config);
  await reportStatus();
  await report();
  await prune();
}

async function loop() {
  if (stopping) return;
  try { await tick(); } catch (error) { console.error("Worker cycle failed:", error); }
  if (!stopping) timer = setTimeout(loop, pollMs);
}

function shutdown() {
  if (stopping) return;
  stopping = true; clearTimeout(timer);
  for (const controller of running.values()) controller.abort();
  setTimeout(() => process.exit(1), 15_000).unref();
  const wait = setInterval(() => { if (!running.size) { clearInterval(wait); store.close(); process.exit(0); } }, 200);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
console.log("Clipflow worker polling", origin.origin, "every", pollMs / 1000, "seconds");
void loop();
