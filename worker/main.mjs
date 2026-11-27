import { access, copyFile, mkdir, open, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { availableParallelism, totalmem } from "node:os";
import { Store, allowed, channelUrl, clipTextFor, dueForProbe, limitFor, plan, queuedClip, retryDelay, stageAfter, clipsInProgress, shownStatus, validateControl, workerTuning } from "./core.mjs";
// A streamer's transcription, subtitles and automatic hook with these settings (its own choices, else the workspace's).
const textOf = (settings, id) => clipTextFor(settings, settings.streamers.find(s => s.id === id));
import { chatSpike, commandTrigger, perSecond } from "./highlights.mjs";
import { openChat } from "./chat.mjs";
import { PROBE_TIMEOUT_MS, lift, probeLive, processWindow, streamlink } from "./media.mjs";
import { checkHealth, codeStamp } from "./health.mjs";
import { normalizeEdit } from "./edit.mjs";
import { makeHighlightVideo } from "./highlights-video.mjs";
import { renderClip, videoInfo } from "./render.mjs";
import { backgroundStart, chooseBackground, localBackground } from "./backgrounds.mjs";
import { Recorder } from "./recorder.mjs";
import { chatSample, LANGUAGE_NAMES, pickerEnabled, rateMoments, rateSegments, sentencesOf, spreadWords, setWriterEnabled, translateClip, writeClipText, writerEnabled } from "./writer.mjs";
import { command } from "./process.mjs";
import { bucketSignals, encodePreview, extractRange, joinSegments, parts, pickMoments, scanRanges, suggestMoments } from "./recordings.mjs";
import { screenText, screenTextAvailable } from "./screentext.mjs";
import { Twitch, clipUrl, momentOf, momentTime, pickClips, twitchLogin, viewerSettings } from "./twitch.mjs";
import { downloadUpload } from "./uploaded-video.mjs";
import { PLATFORM_NAMES, downloadVideo, findYtDlp, videoLink, videoTitle } from "./vod.mjs";
import { setWhisperLanguage, setWhisperModel, stopTranscriber, transcribe as whisper } from "./whisper.mjs";
import { AI_BATCH, autoClipPicks, mergeAiMoments, transcriptWindows } from "./stream-pass.mjs";
import { coverageRoom, coverageWindow, crowdMoments, enqueueTrigger, jobRank, pickJob } from "./triggers.mjs";

// Every log line starts with the time (HH:MM:SS), so how long things take can be read off worker.log.
for (const level of ["log", "warn", "error"]) {
  const original = console[level].bind(console);
  console[level] = (...args) => original(new Date().toTimeString().slice(0, 8), ...args);
}
const run = promisify(execFile);

const env = process.env;
const seconds = (value, fallback) => { const n = Number(value ?? fallback); if (!Number.isFinite(n) || n <= 0) throw new Error("Invalid numeric setting: " + value); return n * 1000; };
const token = env.CLIPFLOW_TOKEN ?? "";
let origin;
try { origin = new URL(env.CLIPFLOW_URL ?? ""); } catch { /* reported below */ }
if (!origin || !/^cfw_[0-9a-f]{64}$/.test(token)) { console.error("Set CLIPFLOW_URL to the dashboard origin and CLIPFLOW_TOKEN to a token from Connect worker."); process.exit(1); }
if (origin.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(origin.hostname)) { console.error("CLIPFLOW_URL must use https."); process.exit(1); }

const dataDir = env.DATA_DIR || "/data";
const pollMs = seconds(env.POLL_SECONDS, 60);
// Settings chosen in the dashboard's Settings → This PC, else this environment (core.mjs workerTuning); refreshed with
// every settings load, so a change there applies within POLL_SECONDS without a restart.
let tuning = workerTuning(null, env);
// Triggers wait in a queue (triggers.mjs); a long chat burst counts as a new trigger at most every CHAT_CLIP_GAP_SECONDS.
// Between triggers the stream is covered in back-to-back windows; COOLDOWN_SECONDS (default 0) spaces those checks out.
// (seconds() refuses 0, which is a valid choice here: back-to-back checks.)
const coverEveryMs = Math.max(0, Number(env.COOLDOWN_SECONDS ?? 0) || 0) * 1000, spikeEveryMs = seconds(env.CHAT_CLIP_GAP_SECONDS, 25);
const bufferSeconds = seconds(env.BUFFER_SECONDS, 240) / 1000;
const liveCheckMs = seconds(env.LIVE_CHECK_SECONDS, 120), probeConcurrency = 3, probesPerCycle = 15;
const postRollMs = 20_000;
// Why a clip was cut; the code is sent to the dashboard with the clip.
const reasonLabel = { command: "!clip in chat", chat: "chat spike", crowd: "viewers clipping it live", audio: "loudest moment", best: "best moment of a recording", manual: "picked in a recording", viewer: "a viewer's Twitch clip" };
// How often a live Twitch channel is asked for the clips viewers just made (each becomes a trigger, see crowdMoments in
// triggers.mjs). 0 turns it off. Needs the worker's Twitch app (the same one viewers' clips use).
const crowdEveryMs = Math.max(0, Number(env.CROWD_CHECK_SECONDS ?? 30) || 0) * 1000;
// Whole-stream recordings: background work (joining, measuring, previews) runs one recording step at a time beside
// clip processing; `recordingRetry` holds a failed step's retry time. `requestsSeen`: clip requests already taken on.
let backgroundBusy = false, backgroundRow = null;
const recordingRetry = new Map(), requestsSeen = new Set(), backgroundController = new AbortController();
const python = env.PYTHON || "python", highlightScript = fileURLToPath(new URL("./highlight.py", import.meta.url));
// Footage kept either side of a moment cut from a recording (more than SOURCE_PAD, so the editor can widen it).
const RECORDING_PAD = 15;
const store = new Store(dataDir);
// streamer id -> { streamer, recorder, chat, startedMs, lastClipMs, queue: [{ atMs, reason }], coveredUntil, lastSpikeMs, busy }
const sessions = new Map(), blockedUntil = new Map(), failures = new Map();
// streamer id -> { status: live|recording|offline|error, checkedAt (ms), title }; `unreported` holds ids changed since the last status post.
const live = new Map(), unreported = new Set();
// streamer id -> live checks failed in a row. A failed check is retried on the next cycle (POLL_SECONDS) rather
// than after the full LIVE_CHECK_SECONDS.
const probeErrors = new Map(), PROBE_ERRORS_SHOWN = 3;
// CPU-heavy work, handled one at a time: extracted windows to turn into clips, and re-renders requested from the
// dashboard editor ({ kind: "render", id, rev, edit, words, source }).
const jobs = [];
const renderRevs = new Map();  // clip id -> newest edit revision already queued or rendered
let config = null, stopping = false, timer, sessionTimer;
// The jobs being worked on ({ job, controller }), at most CLIP_WORKERS (2) at once: while one clip is transcribed
// another can be written or rendered. With one at a time clips queued for minutes while most of the PC's cores sat
// idle (Whisper, the AI writer and ffmpeg each use only some of them). CLIP_WORKERS=1 is the old one-at-a-time.
const running = new Set();
const track = (job, controller) => { const slot = { job, controller }; running.add(slot); return () => running.delete(slot); };
// When the settings were last loaded. A dashboard that doesn't answer (a deploy, an outage) leaves the worker on its last
// settings for up to CONFIG_GRACE_MS: dropping them stopped every recording and threw away every queued clip, which
// lost about a quarter of the moments viewers clipped (115 such stops in 2.5 days).
let configAt = 0, configMissing = false;
// The fingerprint of the dashboard settings this worker runs with (config.workerRev), reported back so Settings → This
// PC can show Applied. null until the first settings load.
let appliedRev = null;
const CONFIG_GRACE_MS = seconds(env.CONFIG_GRACE_SECONDS, 1800);
let pendingError = null;  // latest problem not yet delivered to the dashboard

// Logs a problem and queues it for the dashboard, which shows the most recent one.
function problem(message) {
  const text = String(message).replace(/\s+/g, " ").trim().slice(0, 500);
  console.warn(text);
  pendingError = { message: text, at: new Date().toISOString() };
}

// Redirects are refused so a sign-in wall in front of the dashboard surfaces as an error, not a silent HTML page.
function api(path, { timeout = 20_000, headers = {}, signal, ...init } = {}) {
  return fetch(new URL(path, origin), { ...init, redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout), headers: { authorization: "Bearer " + token, "content-type": "application/json", ...headers } });
}

function setLive(id, status, title = null) {
  live.set(id, { status, checkedAt: Date.now(), title });
  unreported.add(id);
}
const isLive = id => { const s = live.get(id); return s?.status === "live" && Date.now() - s.checkedAt <= liveCheckMs * 2; };
// "https://www.twitch.tv/name" -> { name: "name", platform: "Twitch" }.
function streamerInfo(url) {
  try {
    const u = new URL(url), host = u.hostname.replace(/^www./, ""), parts = u.pathname.split("/").filter(Boolean).filter(p => p !== "live");
    const platform = { "twitch.tv": "Twitch", "kick.com": "Kick", "youtube.com": "YouTube", "tiktok.com": "TikTok" }[host] ?? host;
    return { name: decodeURIComponent(parts.at(-1) ?? "").replace(/^@/, ""), platform };
  } catch { return { name: "", platform: "" }; }
}
const nextUtcMidnight = () => { const d = new Date(); d.setUTCHours(24, 0, 0, 0); return d.getTime(); };

async function probe(streamers) {
  const queue = [...streamers];
  await Promise.all(Array.from({ length: Math.min(probeConcurrency, queue.length) }, async () => {
    for (let s; (s = queue.shift()) && !stopping;) {
      const result = await probeLive(s.url, AbortSignal.timeout(PROBE_TIMEOUT_MS + 10_000)).catch(error => ({ status: "error", title: null, message: error.message }));
      const prev = live.get(s.id), before = prev?.status;
      if (result.status === "error") {
        // One slow or garbled answer proves nothing: keep the last known status and ask again shortly. Only a run
        // of failures is shown as "Check failed".
        const count = (probeErrors.get(s.id) ?? 0) + 1;
        probeErrors.set(s.id, count);
        if (count < PROBE_ERRORS_SHOWN) {
          live.set(s.id, { status: before ?? "error", title: prev?.title ?? null, checkedAt: Date.now() - liveCheckMs });
          console.warn("Live check for " + s.url + " had no answer (" + result.message + "); trying again next cycle");
          continue;
        }
        setLive(s.id, "error");
        problem("Live check failed " + count + " times in a row for " + s.url + ": " + result.message);
        continue;
      }
      probeErrors.delete(s.id);
      setLive(s.id, result.status, result.title);
      if (before !== result.status) console.log("Live check:", s.url, "is", result.status + (result.title ? " (" + result.title + ")" : ""));
    }
  }));
}

// What this PC says about itself with its status (Settings → This PC): the settings it runs with, what it is doing and
// the values it actually uses. Sent when it changes, and at least every DEVICE_EVERY_MS so the dashboard knows it's current.
const DEVICE_EVERY_MS = 5 * 60_000;
let deviceSent = "", deviceSentAt = 0;
function deviceReport() {
  const ready = jobs.filter(startable);
  // How long the oldest clip ready to be made has waited, in whole 5 minutes (so the report doesn't change every
  // minute): a long wait means this PC is falling behind.
  const oldest = ready.length ? Math.min(...ready.map(j => j.queuedAt ?? Date.now())) : null;
  return {
    applied: appliedRev,
    recording: [...sessions.keys()].slice(0, 20), making: Math.min(50, running.size), waiting: ready.length, held: jobs.length - ready.length,
    oldestWaitMin: oldest === null ? 0 : Math.floor((Date.now() - oldest) / 300_000) * 5,
    uses: { maxCaptures: tuning.maxCaptures, clipWorkers: tuning.clipWorkers, whisperModel: tuning.whisperModel, aiWriter: tuning.aiWriter, retentionHours: tuning.retentionHours },
    cores: availableParallelism(), memoryGb: Math.round(totalmem() / 2 ** 30 * 10) / 10,
    health, restartPending,
    // Each clip being made or about to be (Clips → Being made): its stage, and failures from the last two hours.
    clips: clipsInProgress({
      making: [...running].map(r => r.job).filter(j => !j.kind),
      uploading: store.uploading(),
      queued: jobs.filter(j => !j.kind), held: j => !startable(j),
      failed: recentFailures.filter(f => Date.now() - f.at < 2 * 3600_000),
    }),
  };
}
// The last few clips that failed to be made (newest first), for deviceReport, each with its job so it can be made again.
const recentFailures = [], FAILURES_KEPT = 5, FAILURE_KEEP_MS = 2 * 3600_000;
// Drops failures past FAILURES_KEPT or FAILURE_KEEP_MS, deleting the raw window each kept for Try again.
async function trimFailures() {
  const now = Date.now();
  for (let i = recentFailures.length - 1; i >= 0; i--) {
    if (i < FAILURES_KEPT && now - recentFailures[i].at < FAILURE_KEEP_MS) continue;
    const [gone] = recentFailures.splice(i, 1);
    if (gone.job?.dir) await rm(gone.job.dir, { recursive: true, force: true }).catch(() => {});
  }
}
// Try again, asked from Being made (config.retries): the failed job goes back in the queue as it was (same moment, chat and
// settings). Each id is acted on once; one no longer kept (too old, or the worker restarted since) is ignored.
const retriesSeen = new Set();
function takeRetries(ids) {
  let added = 0;
  for (const id of ids ?? []) {
    if (retriesSeen.has(id)) continue;
    retriesSeen.add(id);
    const at = recentFailures.findIndex(f => f.id === id);
    if (at < 0) continue;
    const [{ job }] = recentFailures.splice(at, 1);
    if (!store.unfail(job.id)) continue;
    job.queuedAt = Date.now(); job.stage = undefined; job.retried = true;
    jobs.push(job); added++;
    console.log("Trying again", reasonLabel[job.reason] ?? job.reason, "clip", job.id, "from", job.streamer.url, "(asked from the dashboard)");
  }
  if (added) processJobs();
}

// Health checks (health.mjs): when the worker starts, every HEALTH_EVERY_MS, and again soon after the transcription
// quality or the AI writer changes. They run alongside the cycle, never holding it up.
const HEALTH_EVERY_MS = 10 * 60_000;
let health = null, healthAt = 0, healthRunning = false, healthKey = "";
function maybeCheckHealth() {
  const key = tuning.whisperModel + "|" + tuning.aiWriter;
  if (key !== healthKey) { healthKey = key; healthAt = 0; }
  if (healthRunning || Date.now() - healthAt < HEALTH_EVERY_MS) return;
  healthRunning = true;
  checkHealth({ dataDir, whisperDir: env.WHISPER_DIR || "/data/models", whisperModel: tuning.whisperModel, python, streamlink,
    ollamaUrl: env.OLLAMA_URL || "http://127.0.0.1:11434", ollamaModels: [env.OLLAMA_MODEL || "qwen2.5:7b", env.OLLAMA_PICKER_MODEL || "qwen2.5:3b"],
    aiWriter: tuning.aiWriter, startedStamp })
    .then(h => { health = h; healthAt = Date.now(); })
    .catch(error => console.warn("Health check failed:", error.message))
    .finally(() => { healthRunning = false; });
}

// Restart when idle, asked for from Settings → This PC (config.restartAt later than this start): once nothing is
// recording, being made, ready to be made or uploading, the worker exits cleanly and run-windows.ps1 starts it again on the
// code now on disk. Until then it carries on as usual, recordings included.
const startedAt = Date.now(), startedStamp = await codeStamp();
let restartPending = false;
function restartIfIdle() {
  if (!restartPending && config?.restartAt && Date.parse(config.restartAt) > startedAt) {
    restartPending = true;
    console.log("Restart asked for from the dashboard; restarting once idle");
  }
  // Clips held while paused don't count: they wait for Resume either way and come back after the restart
  // (resumeInterrupted, if under a day old).
  if (!restartPending || sessions.size || running.size || jobs.some(startable) || reporting) return false;
  console.log("Restarting as asked from the dashboard (idle)");
  void shutdown();
  return true;
}

async function reportStatus() {
  // Recording streamers are refreshed every cycle so the dashboard never shows them as stale.
  for (const id of sessions.keys()) setLive(id, "recording", live.get(id)?.title ?? null);
  const device = deviceReport(), deviceText = JSON.stringify(device);
  const deviceDue = deviceText !== deviceSent || Date.now() - deviceSentAt >= DEVICE_EVERY_MS;
  if (!unreported.size && !pendingError && !deviceDue) return;
  const ids = [...unreported], error = pendingError;
  const streamers = ids.filter(id => live.has(id)).map(id => { const s = live.get(id); return { id, status: shownStatus(config, id, s.status, id => store.countToday(id)), checkedAt: new Date(s.checkedAt).toISOString(), title: s.title }; });
  try {
    const response = await api("/api/worker/status", { method: "POST", body: JSON.stringify({ streamers, device, ...(error && { error }) }) });
    if (!response.ok) throw new Error("HTTP " + response.status);
    deviceSent = deviceText; deviceSentAt = Date.now();
    for (const id of ids) unreported.delete(id);
    if (pendingError === error) pendingError = null;
  } catch (failure) { console.warn("Status report deferred:", failure.message); }
}

async function refresh() {
  try {
    const response = await api("/api/worker/config");
    if (!response.ok) throw new Error("HTTP " + response.status);
    config = validateControl(await response.json());
    configAt = Date.now();
    tuning = workerTuning(config, env);
    pickTwitchFrom(config);
    setWriterEnabled(tuning.aiWriter);
    // Transcription quality: from the next transcription (one already running finishes with its model).
    setWhisperModel(tuning.whisperModel);
    setWhisperLanguage(tuning.language);
    appliedRev = typeof config?.workerRev === "string" ? config.workerRev : null;
    // More clips at once takes effect now, not when the next job arrives.
    if (jobs.length) processJobs();
    if (configMissing) { configMissing = false; console.log("Dashboard reachable again"); }
  } catch (error) {
    if (config && Date.now() - configAt < CONFIG_GRACE_MS) {
      if (!configMissing) { configMissing = true; console.warn("Dashboard unavailable (" + error.message + "); carrying on with the last settings for up to " + Math.round(CONFIG_GRACE_MS / 60_000) + " minutes"); }
      return;
    }
    if (config) console.warn("Dashboard unavailable for " + Math.round((Date.now() - configAt) / 60_000) + " minutes; stopping recordings:", error.message);
    else console.warn("Config unavailable:", error.message);
    config = null;
  }
}

async function startSession(streamer) {
  // record / both keep the whole stream in its own folder; clip keeps only the rolling buffer.
  const mode = streamer.captureMode ?? "clip", keep = mode !== "clip";
  // marks: when "!clip" was typed during a record-only stream; those moments are clipped when it ends.
  const recording = keep ? { id: crypto.randomUUID(), chat: [], chatSeen: 0, startMs: 0, marks: [] } : null;
  if (recording) recording.dir = join(dataDir, "recordings", recording.id);
  const recorder = new Recorder(channelUrl(streamer.url), keep ? join(recording.dir, "segments") : join(dataDir, "buffer", streamer.id), { bufferSeconds, streamlink, keep });
  const session = { streamer, mode, recording, recorder, chat: null, startedMs: Date.now(), lastClipMs: Date.now(), queue: [], coveredUntil: Date.now(), lastSpikeMs: 0, busy: false, commandSeen: Date.now(), crowd: { lastPoll: 0, polling: false, seen: new Set(), warned: false } };
  sessions.set(streamer.id, session);
  try { await recorder.start(); }
  catch (error) { sessions.delete(streamer.id); problem("Could not start recording " + streamer.url + ": " + error.message); return; }
  session.chat = openChat(streamer.url);
  setLive(streamer.id, "recording", live.get(streamer.id)?.title ?? null);
  if (recording) {
    recording.startMs = Date.now();
    store.addRecording(recording.id, streamer.id, recording.dir, mode);
    if (live.get(streamer.id)?.title) store.setRecording(recording.id, { title: live.get(streamer.id).title });
    void syncRecordings();
  }
  console.log(mode === "record" ? "Recording (whole stream, clipped afterwards)" : mode === "both" ? "Recording and clipping" : "Recording", streamer.url, session.chat ? "(watching chat)" : "(audio only)");
}

async function stopSession(id, reason) {
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);
  session.chat?.close();
  const failure = session.recorder.error;
  await session.recorder.stop();
  if (session.recording) {
    // Chat per second over the recording, for its heat strip and best-moment picks.
    logChat(session, true);
    const { recording } = session;
    await writeFile(join(recording.dir, "chat.json"), JSON.stringify(Array.from(recording.chat, v => v ?? 0))).catch(() => {});
    // "!clip" moments, in seconds into the recording.
    const marks = recording.marks.map(t => session.recorder.footageMs(t)).filter(at => at != null).map(at => Math.round((at - recording.startMs) / 1000)).filter(at => at > 0);
    if (marks.length) await writeFile(join(recording.dir, "marks.json"), JSON.stringify(marks)).catch(() => {});
    store.setRecording(recording.id, { state: "ended", ended_at: new Date().toISOString(), reported: 0 });
    void syncRecordings();
    void runBackground();
  }
  if (failure) problem("Recording " + session.streamer.url + " failed: " + failure);
  else console.log("Stopped recording", session.streamer.url + ":", reason);
}

// Adds chat messages seen since the last call to the recording's per-second counts (the chat client itself only
// keeps the last few minutes). Counts are placed on the footage's clock, so a resume's gap doesn't shift the chat
// after it. Until the end, only messages up to the latest recorded segment are taken: a gap is known once
// footage after it arrives.
function logChat(session, final = false) {
  const r = session.recording;
  if (!r || !session.chat) return;
  const until = final ? Infinity : session.recorder.latestMs();
  for (const t of session.chat.times) {
    if (t <= r.chatSeen) continue;
    if (t > until) break;
    r.chatSeen = t;
    const at = session.recorder.footageMs(t);
    const i = at == null ? -1 : Math.floor((at - r.startMs) / 1000);
    if (i >= 0) r.chat[i] = (r.chat[i] ?? 0) + 1;
  }
}

// Copies the buffered window out immediately (the buffer moves on), then queues the slow processing.
async function clipWindow(session, fromMs, toMs, reason) {
  const { streamer } = session, settings = config;
  const id = crypto.randomUUID(), dir = join(dataDir, "clips", streamer.id, id), raw = join(dir, "window.m2t");
  session.busy = true;
  try {
    store.add(id, streamer.id, join(dir, "clip.mp4"), settings.duration, textOf(settings, streamer.id).subtitles, reason);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const rawStartMs = await session.recorder.extract(fromMs, toMs, raw, AbortSignal.timeout(60_000));
    const length = (toMs - rawStartMs) / 1000 + 10;
    // The streamer's own look if one is saved, else the workspace's.
    const style = settings.streamers.find(s => s.id === streamer.id)?.style ?? settings.style ?? null;
    // What chat said during the window (Twitch), for the AI writer.
    const chatLines = session.chat?.lines.filter(l => l.t >= rawStartMs && l.t <= toMs + 15_000) ?? [];
    const chat = session.chat ? perSecond(session.chat.times, rawStartMs, length) : [], focusFrom = (fromMs - rawStartMs) / 1000, focusTo = (toMs - rawStartMs) / 1000;
    // strength: how far chat jumped in this moment, so a backlog makes the biggest moments first (triggers.mjs pickJob).
    jobs.push({ queuedAt: Date.now(), id, dir, raw, streamer, settings, style, reason, rawStartMs, chatLines, chat, focusFrom, focusTo, strength: lift(chat, focusFrom, focusTo) ?? 0 });
    void processJobs();
  } catch (error) {
    store.fail(id);
    await rm(dir, { recursive: true, force: true });
    problem("Could not cut a clip window for " + streamer.url + ": " + error.message);
  } finally { session.busy = false; }
}

// Starts lanes (up to clipWorkers) that each take the next job until none can be started.
let lanes = 0;
function processJobs() {
  while (lanes < tuning.clipWorkers && !stopping && jobs.some(startable)) {
    lanes += 1;
    void lane().finally(() => { lanes -= 1; if (!stopping && jobs.length) processJobs(); });
  }
}
// Not alongside another job for the same clip (a re-render while its translation renders) or a second highlight video,
// and not a live clip while automation or its streamer is paused: those wait for Resume (queuedClip in core.mjs).
const isLiveClip = j => !j.kind && !j.fromRecording && j.streamer;
const startable = j => !(isLiveClip(j) && queuedClip(config, j.streamer.id) === "hold") && ![...running].some(r => r.job.id === j.id || (j.kind === "highlight" && r.job.kind === "highlight"));
async function lane() {
  while (!stopping) {
    // Fewer clips at once (Settings → This PC): a lane beyond the new number stops once its clip is done, rather than
    // cutting it short or carrying on until the queue is empty.
    if (lanes > tuning.clipWorkers) return;
    // Moments people reacted to before coverage checks, fresh before resumed, highlight videos last (triggers.mjs).
    const ready = jobs.filter(startable);
    if (!ready.length) return;
    const job = pickJob(ready);
    jobs.splice(jobs.indexOf(job), 1);
    if (job.kind === "render") await rerender(job);
    else if (job.kind === "translate") await translateJob(job);
    else if (job.kind === "highlight") await highlightJob(job);
    else await clipJob(job);
  }
}
// A clip whose transcription timed out keeps a copy of its raw window in DATA_DIR/diagnostics (the newest
// DIAGNOSTICS_KEPT), so the exact audio can be run through Whisper again later. Try again keeps the window only for two
// hours, and the one that hung on 27 Nov was deleted before anyone could look at it.
const DIAGNOSTICS_KEPT = 3;
async function keepForDiagnosis(job) {
  try {
    const dir = join(dataDir, "diagnostics");
    await mkdir(dir, { recursive: true });
    const name = new Date().toISOString().replace(/[:.]/g, "-") + "-" + job.id + ".m2t";
    await copyFile(job.raw, join(dir, name));
    const kept = (await readdir(dir)).filter(f => f.endsWith(".m2t")).sort();
    for (const old of kept.slice(0, Math.max(0, kept.length - DIAGNOSTICS_KEPT))) await rm(join(dir, old), { force: true });
    console.log("Kept the audio of clip " + job.id + " for diagnosis: " + join(dir, name));
  } catch (error) { console.warn("Could not keep clip " + job.id + " for diagnosis: " + error.message); }
}
async function clipJob(job) {
  const startedAt = Date.now();
  {
    // Live captures are dropped once automation is stopped or their streamer removed (paused ones wait in the queue, and a
    // streamer stopped on its own still finishes the ones it captured; see
    // startable); clips asked for from a recording were asked for by hand.
    if (!job.fromRecording && queuedClip(config, job.streamer.id) !== "run") {
      if (queuedClip(config, job.streamer.id) === "hold") { jobs.push(job); return; }
      store.fail(job.id); await rm(job.dir, { recursive: true, force: true });
      console.log("Dropped a queued", reasonLabel[job.reason] ?? job.reason, "clip from", job.streamer.url + ":", config ? "automation was stopped and the queue cleared, or the streamer was removed" : "no settings from the dashboard");
      return;
    }
    const controller = new AbortController(), untrack = track(job, controller);
    let made = false, why = null;
    // Its stage for the dashboard's "Being made" list (stageAfter in core.mjs), moved on as each step finishes.
    job.stage = "transcribing"; job.stageAt = Date.now();
    const onStep = step => { const next = stageAfter(step, writerEnabled()); if (next && next !== job.stage) { job.stage = next; job.stageAt = Date.now(); } };
    try {
      // The streamer's name and stream title help Whisper spell them and give the AI writer context.
      // An imported viewer's clip brings its own title.
      const who = streamerInfo(job.streamer.url), title = job.title ?? live.get(job.streamer.id)?.title ?? null;
      const writer = ({ transcript, from, to }) => writeClipText({ transcript, streamer: who.name, platform: who.platform, title,
        chat: job.chatLines?.length ? chatSample(job.chatLines, job.rawStartMs + from * 1000, job.rawStartMs + to * 1000 + 10_000) : [] }, { signal: controller.signal });
      const result = await processWindow(job.raw, { settings: job.settings, text: textOf(job.settings, job.streamer.id), style: job.style, focusFrom: job.focusFrom, focusTo: job.focusTo, chat: job.chat, exact: !!job.exact,
        hint: [who.name, title].filter(Boolean).join(". "), writer: writerEnabled() ? writer : null,
        // Weighs what was said when choosing the moment (not for exact picks, which are kept as they are).
        // Chat against loudness for this streamer, as learned from how its clips did (0.5 until then).
        chatWeight: job.settings.streamers.find(s => s.id === job.streamer.id)?.chatWeight ?? 0.5,
        // Twitch chat during the window, kept with the clip so it can be shown on it.
        messages: (job.chatLines ?? []).map(l => [(l.t - job.rawStartMs) / 1000, l.name ?? "", l.text, l.color ?? null]),
        // Clips with no other sign of a moment (the every-10-minutes check on streams without chat) are skipped when the
        // AI rates every candidate below AI_MIN_RATING (default 6 of 10); chat spikes, !clip and viewers' clips never are.
        minRating: job.reason === "audio" ? tuning.minRating || null : null, autoHooks: tuning.autoHooks, onStep,
        rater: pickerEnabled() && !job.exact ? texts => rateMoments(texts, { streamer: who.name, title, chat: job.chatLines?.length ? chatSample(job.chatLines, job.rawStartMs, job.rawStartMs + 120_000, 15) : [] }, { signal: controller.signal }) : null, findFacecam, background: edit => backgroundFor(edit, job.id, title ?? "") }, job.dir, controller.signal);
      store.ready(job.id, result.sha, Math.min(90, Math.max(15, Math.round(result.end - result.start))));
      made = true;
      console.log("Clip ready", job.id, "from", job.streamer.url, "(" + reasonLabel[job.reason] + ", " + Math.round(result.end - result.start) + "s)");
      // Where the time went: waiting in the queue, then each step (seconds).
      const steps = Object.entries(result.timings ?? {}).map(([k, v]) => k + " " + v + "s").join(", ");
      console.log("  timings: waited " + Math.round((startedAt - (job.queuedAt ?? startedAt)) / 1000) + "s, " + steps + ", total " + Math.round((Date.now() - startedAt) / 1000) + "s");
    } catch (error) {
      store.fail(job.id);
      why = error.message;
      // A clip that really failed keeps its raw window (and the job, in recentFailures) so Being made can offer
      // Try again; skipped and cancelled ones don't need it.
      const retryable = !error.skip && !controller.signal.aborted && !job.kind;
      if (!retryable) await rm(job.dir, { recursive: true, force: true });
      // Skipped on purpose (nothing worth a clip): not a problem, and it doesn't count towards the daily limit.
      if (error.skip) console.log("Skipped a", reasonLabel[job.reason], "on", job.streamer.url + ":", error.message, "(after " + Math.round((Date.now() - startedAt) / 1000) + "s)");
      else if (!controller.signal.aborted) {
        problem("Clip processing failed for " + job.streamer.url + ": " + error.message + " (after " + Math.round((Date.now() - startedAt) / 1000) + "s)");
        if (/transcription timed out/.test(error.message)) void keepForDiagnosis(job);
        // Shown in "Being made" for a while, so a clip that never arrives isn't a mystery.
        recentFailures.unshift({ id: job.id, streamer: job.streamer.id, reason: job.reason ?? null, at: Date.now(), why: error.message, job });
        void trimFailures();
      }
      else console.log("Cancelled a", reasonLabel[job.reason] ?? job.reason, "clip from", job.streamer.url, stopping ? "(worker stopping; it resumes on start)" : "(streamer paused, stopped or disabled)");
    } finally { untrack(); }
    if (job.tracker) settleRequest(job.tracker, made, why);
    void report();
  }
}

// Asks Twitch (every crowdEveryMs) for the clips viewers just made on a live channel and queues each one's moment while
// it's still in the buffer, like a chat spike (crowdMoments in triggers.mjs). Runs alongside checkSessions, not in it.
async function pollCrowd(session) {
  const c = session.crowd, login = twitchLogin(session.streamer.url);
  // Through the site's Twitch app (shared by every workspace's worker, one rate limit) at most once a minute.
  const everyMs = twitch?.via ? Math.max(60_000, crowdEveryMs) : crowdEveryMs;
  if (!twitch || !crowdEveryMs || !login || c.polling || Date.now() - c.lastPoll < everyMs) return;
  c.polling = true; c.lastPoll = Date.now();
  try {
    const list = await twitch.clips(login, new Date(Date.now() - 6 * 60_000));
    const starts = await twitch.startsOf(list).catch(() => new Map());
    if (sessions.get(session.streamer.id) !== session) return;
    // The moment's end must still be in the buffer, a little after its oldest footage.
    const latest = session.recorder.latestMs(), earliestMs = latest - session.recorder.buffered() * 1000 + 15_000, now = Date.now();
    for (const m of crowdMoments(list, { seen: c.seen, starts, earliestMs, nowMs: now })) {
      const what = enqueueTrigger(session.queue, session.coveredUntil, { atMs: m.atMs, reason: "crowd" });
      console.log("A viewer clipped", session.streamer.url, Math.round((now - m.atMs) / 1000) + "s ago" + (what === "queued" ? "" : what === "merged" ? " (same moment)" : " (already in a clip)"));
    }
    // Only what Twitch still lists (the last 6 minutes) needs remembering.
    const listed = new Set(list.map(x => x.id));
    for (const id of c.seen) if (!listed.has(id)) c.seen.delete(id);
  } catch (error) {
    if (!c.warned) { c.warned = true; console.log("Couldn't check viewers' live clips on", session.streamer.url + ":", error.message); }
  } finally { c.polling = false; }
}

// Runs every few seconds: ends sessions that should stop and turns chat spikes or quiet periods into clips.
async function checkSessions() {
  const now = Date.now();
  // Re-renders were asked for by hand and run regardless of automation. A live clip being made is finished when its
  // streamer or automation is paused, and cancelled once either is stopped.
  for (const r of running) if (r.job.streamer && !r.job.fromRecording && queuedClip(config, r.job.streamer.id) === "drop") r.controller.abort();
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
    logChat(session);
    // The daily limit stops a clip-only capture; a recorded stream keeps recording and only stops being clipped.
    const dailyLimit = limitFor(settings, id), madeToday = store.countToday(id), limitReached = madeToday >= dailyLimit;
    if (limitReached && session.mode === "clip") { blockedUntil.set(id, nextUtcMidnight()); await stopSession(id, "daily clip limit reached"); continue; }
    if (session.recorder.buffered() > 30) failures.delete(id);
    // "!clip" in Twitch chat (Settings → Chat command): clips the moment just before it, without waiting for the
    // gap between chat-spike clips. Commands older than 2 minutes are dropped, e.g. ones typed while at the limit.
    const command = session.chat ? commandTrigger(session.chat.commands, { sinceMs: Math.max(session.commandSeen, now - 120_000), who: settings.clipCommand }) : null;
    if (command && session.mode === "record") { session.commandSeen = command.atMs; session.recording.marks.push(command.atMs); console.log("!clip from", command.by, "on", name + ": marked for when the stream ends"); }
    // Record-only streams are clipped when they end, from the whole recording.
    if (session.busy || session.mode === "record" || limitReached) continue;
    // Viewers clipping a moment live (Twitch): queued like a chat spike when the answer comes back.
    if (session.chat) void pollCrowd(session);
    const latest = session.recorder.latestMs(), preRollMs = Math.max(45, settings.duration + 15) * 1000;
    // "!clip" and chat spikes queue up (triggers.mjs): none is lost to a cool-down, ones close together become one clip.
    if (command) {
      session.commandSeen = command.atMs;
      const what = enqueueTrigger(session.queue, session.coveredUntil, { atMs: command.atMs, reason: "command" });
      console.log("!clip from", command.by, "on", name + (what === "queued" ? "" : what === "merged" ? " (joins a moment already queued)" : " (already in a clip)"));
    }
    if (session.chat && now - session.lastSpikeMs >= spikeEveryMs) {
      const spike = chatSpike(session.chat.times, now, { sinceMs: Math.max(session.chat.since, session.startedMs), factor: tuning.spikeFactor });
      if (spike.spike) {
        session.lastSpikeMs = now;
        const what = enqueueTrigger(session.queue, session.coveredUntil, { atMs: now, reason: "chat" });
        console.log("Chat spike on", name + ":", spike.recent, "messages in 10s vs typical", spike.baseline + (what === "queued" ? "" : what === "merged" ? " (same moment)" : " (already in a clip)"));
      }
    }
    // The oldest queued moment, once there's footage after it.
    const next = session.queue[0];
    if (next) {
      if (latest >= next.atMs + postRollMs) {
        session.queue.shift();
        session.lastClipMs = now;
        session.coveredUntil = Math.max(session.coveredUntil, next.atMs + postRollMs);
        void clipWindow(session, next.atMs - preRollMs, next.atMs + postRollMs, next.reason);
      }
      continue;
    }
    // Nothing triggered: check the next stretch nobody has looked at yet (the AI rating drops the dull ones).
    const lookbackS = Math.min(bufferSeconds - 20, Math.max(pickerEnabled() ? 180 : 90, settings.duration * 2));
    if (now - session.lastClipMs < coverEveryMs || session.recorder.buffered() < lookbackS * 0.8) continue;
    // The last part of the daily limit is kept for moments people react to.
    if (!coverageRoom(madeToday, dailyLimit, tuning.coverageShare)) continue;
    const span = coverageWindow({ coveredUntil: session.coveredUntil, latest, lookbackMs: lookbackS * 1000, waiting: jobs.filter(j => j.reason === "audio" && !j.resumed).length + [...running].filter(r => r.job.reason === "audio" && !r.job.resumed).length });
    if (span) {
      session.lastClipMs = now;
      session.coveredUntil = span.toMs;
      void clipWindow(session, span.fromMs, span.toMs, "audio");
    }
  }
}

// ---- Viewers' Twitch clips ----
// With viewers' clips on (Settings, or a streamer's own setting; see twitch.mjs viewerSettings), every IMPORT_MINUTES
// (30) the most-viewed clips viewers made on each running Twitch streamer's channel are looked at: at least minViews
// views, a moment from the last maxHours hours, not a moment already taken. Up to 2 at a time and perDay a day become
// clips (they don't use the daily clip limit), or with "ask me first" up to 5 at a time are listed in the dashboard,
// where picked ones come back as config.viewerClipPicks. Uses this worker's own Twitch app when .env has one
// (TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET), otherwise the dashboard's, through /api/worker/twitch, once its settings
// say it has one (config.twitchApp); `twitch` is null until either is there. Clips taken or offered are remembered for a
// week in viewer-clips.json, with their moment, so none comes twice and no moment twice (see sameMoment).
const ownTwitch = Twitch.fromEnv(env), siteTwitch = Twitch.viaSite((resource, params) => api("/api/worker/twitch?" + new URLSearchParams([["resource", resource], ...params])));
let twitch = ownTwitch;
const pickTwitchFrom = settings => { if (!ownTwitch) twitch = settings?.twitchApp === true ? siteTwitch : null; };
const importEveryMs = seconds(env.IMPORT_MINUTES, 30) * 60, seenFile = join(dataDir, "viewer-clips.json");
let lastImport = 0, importing = false, twitchWarned = false, seenCache = null;
// Each entry: when it was taken or offered and its moment ({ at, ...momentOf, offered?, clip? }); older entries are
// just the time.
async function seenClips() {
  if (!seenCache) {
    seenCache = await readJson(seenFile, {});
    const weekAgo = Date.now() - 7 * 86_400_000;
    for (const [clip, v] of Object.entries(seenCache)) if (!(Date.parse(typeof v === "string" ? v : v?.at) > weekAgo)) delete seenCache[clip];
  }
  return seenCache;
}
const saveSeen = () => writeFile(seenFile, JSON.stringify(seenCache ?? {}));
async function viewerReport(body) {
  const response = await api("/api/worker/viewer-clips", { method: "POST", body: JSON.stringify(body) });
  if (!response.ok) throw new Error("HTTP " + response.status);
}
async function importViewerClips() {
  if (importing || stopping || !config || Date.now() - lastImport < importEveryMs) return;
  const settings = config;
  const wanted = settings.streamers.map(s => [s, viewerSettings(settings, s)]).filter(([s, v]) => v.on && twitchLogin(s.url) && allowed(settings, s.id));
  if (!wanted.length) return;
  if (!twitch) {
    if (!twitchWarned) { twitchWarned = true; problem("Viewers' Twitch clips are switched on, but this site has no Twitch app set up yet, and this worker has none of its own (see the worker README)."); }
    return;
  }
  importing = true; lastImport = Date.now();
  try {
    const seen = await seenClips();
    for (const [streamer, v] of wanted) {
      const login = twitchLogin(streamer.url), room = v.ask ? 5 : Math.min(2, v.perDay - store.countViewerToday(streamer.id));
      if (room <= 0 || stopping) continue;
      let list, starts;
      try { list = await twitch.clips(login, new Date(Date.now() - v.maxHours * 3_600_000)); starts = await twitch.startsOf(list); }
      catch (error) { problem("Couldn't list viewers' Twitch clips for " + login + ": " + error.message); continue; }
      // The moments already taken: as Twitch lists them now (their place in the broadcast may have been filled in
      // since), else as remembered. Fresh: the moment itself is within maxHours, not just the clipping.
      const listed = new Map(list.map(c => [c.id, c])), now = Date.now();
      const taken = Object.entries(seen).map(([clip, x]) => listed.get(clip) ?? (typeof x === "object" ? x : null)).filter(Boolean);
      const fresh = c => now - momentTime(c, starts) <= v.maxHours * 3_600_000;
      const picks = pickClips(list, { minViews: v.minViews, seen: new Set(Object.keys(seen)), max: room, taken, keep: fresh });
      if (v.ask) {
        if (!picks.length) continue;
        const at = c => { const t = momentTime(c, starts); return Number.isFinite(t) ? new Date(t).toISOString() : null; };
        try {
          await viewerReport({ offer: picks.map(c => ({ id: c.id, streamerId: streamer.id, title: String(c.title ?? "").slice(0, 300), views: Number(c.view_count) || 0, duration: Number(c.duration) || 0,
            creator: c.creator_name ? String(c.creator_name).slice(0, 100) : null, thumbnail: c.thumbnail_url ?? null, createdAt: c.created_at, momentAt: at(c), videoId: c.video_id || null, vodOffset: Number.isFinite(c.vod_offset) ? c.vod_offset : null })) });
        } catch (error) { problem("Couldn't list viewers' Twitch clips in the dashboard: " + error.message); continue; }
        for (const c of picks) seen[c.id] = { at: new Date().toISOString(), ...momentOf(c), offered: true };
        await saveSeen();
        console.log("Listed", picks.length, "viewer clip(s) from", streamer.url, "for you to pick");
        continue;
      }
      for (const clip of picks) {
        seen[clip.id] = { at: new Date().toISOString(), ...momentOf(clip) };
        await saveSeen();
        await importClip(streamer, clip, settings);
      }
    }
  } catch (error) { problem("Importing viewers' Twitch clips failed: " + error.message); }
  finally { importing = false; }
}
// Viewers' clips picked in the dashboard: made one at a time, each reported imported (with its clip) or failed. A
// report that doesn't get through is sent again on the next check.
const pickReports = [], picking = new Set();
async function sendPickReports() {
  if (!pickReports.length) return;
  const batch = pickReports.splice(0);
  try { await viewerReport({ done: batch }); } catch { pickReports.unshift(...batch); }
}
async function makeViewerPicks() {
  await sendPickReports();
  if (!config || stopping) return;
  const picks = config.viewerClipPicks.filter(p => !picking.has(p.id) && !pickReports.some(r => r.id === p.id));
  if (!picks.length) return;
  const seen = await seenClips(), settings = config;
  for (const p of picks) picking.add(p.id);
  try {
    for (const p of picks) {
      if (stopping) break;
      const streamer = settings.streamers.find(s => s.id === p.streamerId), before = typeof seen[p.id] === "object" ? seen[p.id] : {};
      // Already made (its report was lost): report it again.
      const made = before.clip ? { id: before.clip } : streamer ? await importClip(streamer, { id: p.id, duration: p.duration, view_count: p.views, title: p.title }, settings) : { error: "The streamer was removed." };
      if (made.id) { seen[p.id] = { ...before, at: new Date().toISOString(), clip: made.id }; await saveSeen(); }
      pickReports.push(made.id ? { id: p.id, state: "imported", clip: made.id } : { id: p.id, state: "failed", error: String(made.error).slice(0, 300) });
    }
    await sendPickReports();
  } finally { for (const p of picks) picking.delete(p.id); }
}
// Downloads a viewer's clip and queues it like any other clip. Returns { id } (the new clip) or { error }.
async function importClip(streamer, clip, settings) {
  const id = crypto.randomUUID(), dir = join(dataDir, "clips", streamer.id, id), raw = join(dir, "window.mp4");
  try {
    await mkdir(dir, { recursive: true });
    await command(streamlink, ["--http-timeout", "20", "--force", "-o", raw, clipUrl(clip.id), "best"], { timeout: 180_000 }).done;
    store.add(id, streamer.id, join(dir, "clip.mp4"), Math.min(90, Math.max(15, Math.round(Number(clip.duration)))), textOf(settings, streamer.id).subtitles, "viewer");
    const style = settings.streamers.find(s => s.id === streamer.id)?.style ?? settings.style ?? null;
    // The whole clip, as the viewer cut it.
    jobs.push({ queuedAt: Date.now(), id, dir, raw, streamer, settings, style, reason: "viewer", exact: true, focusFrom: 0, focusTo: Infinity, chat: [], title: String(clip.title ?? "").trim().slice(0, 140) || null });
    console.log("Imported a viewer's Twitch clip from", streamer.url, "(" + clip.view_count + " views):", clip.id);
    void processJobs();
    return { id };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    problem("Couldn't download the viewer's Twitch clip " + clip.id + ": " + error.message);
    return { error: "Couldn't download it from Twitch: " + error.message };
  }
}

// ---- Imported videos ----
// A Twitch or Kick VOD or a YouTube video pasted on the Recordings page (config.imports) is downloaded, one at a
// time, into a recording folder and then handled like a recorded stream: saved, measured, previewed and clipped
// as asked. A download cut short by the worker stopping starts again when it is back; one deleted in the dashboard
// meanwhile is cancelled.
let videoDownload = null;  // { id, controller } of the download running now
function takeImports(list) {
  if (videoDownload && config?.recordings && !config.recordings.includes(videoDownload.id)) videoDownload.controller.abort();
  if (videoDownload || stopping) return;
  const next = (list ?? []).find(v => { const row = store.recording(v.id); return !row || row.state === "importing"; });
  if (next) void importVideo(next);
}
async function importVideo(item) {
  const link = item.uploaded ? { url: "uploaded video " + item.id } : videoLink(item.url), dir = join(dataDir, "recordings", item.id), controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, backgroundController.signal]);
  videoDownload = { id: item.id, controller };
  if (!store.recording(item.id)) store.addRecording(item.id, item.streamerId, dir, "import");
  store.setRecording(item.id, { state: "importing", reported: 0 });
  try {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    void syncRecordings();
    if (item.uploaded) {
      await downloadUpload(item.id, dir, api, signal);
    } else {
    const ytdlp = await findYtDlp(env, python);
    const title = await videoTitle(link, { ytdlp, streamlink, signal });
    if (title) store.setRecording(item.id, { title, reported: 0 });
    console.log("Importing", PLATFORM_NAMES[link.platform], "video", link.url, "with", ytdlp ? "yt-dlp" : "streamlink");
    await downloadVideo(link, dir, join(dir, "recording.mp4"), { ytdlp, streamlink, signal });
    }
    store.setRecording(item.id, { state: "ended", ended_at: new Date().toISOString(), reported: 0 });
    console.log("Imported", link.url);
  } catch (error) {
    if (stopping) return;  // started again next time
    if (controller.signal.aborted) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      store.removeRecording(item.id);
      console.log("Import of", link.url, "cancelled (deleted in the dashboard)");
      return;
    }
    store.setRecording(item.id, { state: "failed", error: ("Couldn't download the video: " + error.message).slice(0, 300), reported: 0 });
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    problem("Importing " + link.url + " failed: " + error.message);
  } finally {
    videoDownload = null;
    if (!stopping) { void syncRecordings(); void runBackground(); }
  }
}

// ---- Whole-stream recordings ----
const recordingFile = row => join(row.dir, "recording.mp4");
const readJson = async (path, fallback) => { try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; } };

// Sends the dashboard each recording's latest state (upserted there), retrying ones that didn't get through.
async function syncRecordings() {
  for (const row of store.recordings()) {
    if (row.reported) continue;
    const signals = row.state === "ready" ? await readJson(join(row.dir, "signals.json"), null) : null;
    const size = row.state === "ready" ? (await stat(recordingFile(row)).catch(() => null))?.size ?? null : null;
    try {
      const response = await api("/api/worker/recordings", { method: "POST", body: JSON.stringify({ op: "recording", id: row.id, streamerId: row.streamer, startedAt: row.started_at, endedAt: row.ended_at, title: row.title ?? null,
        state: row.state === "ended" ? "processing" : row.state, imported: row.mode === "import", duration: row.duration == null ? null : Math.round(row.duration), size, signals, error: row.error ?? null }) });
      // 404: the streamer was removed; nothing more to tell the dashboard about this recording.
      if (response.ok || response.status === 404) store.setRecording(row.id, { reported: 1 });
      else throw new Error("HTTP " + response.status);
    } catch (error) { console.warn("Recording report deferred:", error.message); }
  }
}

// Works through recordings that need something done, one step at a time: join the segments and measure loudness,
// pick the best moments (record mode), then make and upload the preview.
async function runBackground() {
  if (backgroundBusy || stopping) return;
  backgroundBusy = true;
  try {
    for (;;) {
      const now = Date.now();
      const due = r => (recordingRetry.get(r.id) ?? 0) <= now;
      // Transcribing for search comes last: after every other recording's steps, and only while no clip is being made.
      const row = store.recordings().find(r => due(r) && (r.state === "ended" || (r.state === "ready" && (!r.clipped || !r.previewed || !r.scanned))))
        ?? (!running.size && !jobs.length ? store.recordings().find(r => due(r) && r.state === "ready" && (!r.transcribed || !r.rated)) : undefined);
      if (!row || stopping) break;
      backgroundRow = row.id;
      try { await recordingStep(row); recordingRetry.delete(row.id); }
      catch (error) {
        if (stopping) break;
        recordingRetry.set(row.id, now + 10 * 60_000);
        problem("Recording " + row.id.slice(0, 8) + ": " + error.message + " (retrying in 10 minutes)");
      } finally { backgroundRow = null; }
    }
  } finally { backgroundBusy = false; }
}

async function recordingStep(row) {
  const signal = backgroundController.signal, file = recordingFile(row);
  if (row.state === "ended") {
    const exists = await access(file).then(() => true, () => false);
    if (!exists && !await joinSegments(join(row.dir, "segments"), file, signal)) {
      store.setRecording(row.id, { state: "failed", error: "Nothing was recorded.", reported: 0 });
      return void syncRecordings();
    }
    const info = await videoInfo(file, signal);
    // Loudness for every second of the stream (at a low sample rate: it's only loudness).
    await command(python, [highlightScript, file, join(row.dir, "energy.json"), "0", "1000"], { signal, timeout: Math.max(10 * 60_000, Math.ceil(info.duration) * 200) }).done;
    const { energy } = await readJson(join(row.dir, "energy.json"), { energy: [] });
    const chat = await readJson(join(row.dir, "chat.json"), []);
    // The heat strip, and moments to suggest in the pick list (improved once the screen has been read, below).
    await writeFile(join(row.dir, "signals.json"), JSON.stringify({ ...bucketSignals(energy, chat), moments: suggestions(energy, chat, []) }));
    // Only "record" has its best moments picked here: "both" was clipped live, and an imported video makes the clips
    // asked for with it.
    store.setRecording(row.id, { state: "ready", duration: info.duration || energy.length, clipped: row.mode === "record" ? 0 : 1, transcribed: 0, rated: 0, reported: 0 });
    void syncRecordings();
    console.log("Recording", row.id.slice(0, 8), "saved:", Math.round((info.duration || energy.length) / 60), "minutes");
    return;
  }
  if (!row.clipped) {
    if (!config) throw new Error("waiting for the dashboard settings");
    // Moments marked with "!clip" first, then the best of the rest up to the daily limit.
    const dailyLimit = limitFor(config, row.streamer), marks = (await readJson(join(row.dir, "marks.json"), [])).slice(0, dailyLimit);
    for (const m of marks) {
      try { await clipFromRecording(row, Math.max(0, m - config.duration), m + 5, { reason: "command", exact: false, tracker: null }); }
      catch (error) { problem("Could not cut a !clip moment from recording " + row.id.slice(0, 8) + ": " + error.message); }
    }
    const made = marks.length + (marks.length < dailyLimit ? await clipBestMoments(row, dailyLimit - marks.length, null) : 0);
    store.setRecording(row.id, { clipped: 1 });
    console.log("Recording", row.id.slice(0, 8) + ":", made, "best moment(s) queued for clipping");
    return;
  }
  if (!row.previewed) {
    const preview = join(row.dir, "preview.mp4");
    try {
      await encodePreview(file, preview, row.duration ?? 3600, signal);
      const stored = await uploadPreview(row, preview);
      store.setRecording(row.id, { previewed: 1 });
      console.log("Recording", row.id.slice(0, 8) + ":", stored ? "preview uploaded" : "dashboard storage is off, so there is no preview");
    } finally { await rm(preview, { force: true }); }
    return;
  }
  if (!row.scanned) {
    // Game banners on screen around the strongest moments, then the pick list again with them.
    if (!await screenTextAvailable(python)) {
      if (!screenTextWarned) { screenTextWarned = true; console.log("On-screen text isn't read: install RapidOCR on this PC (py -m pip install rapidocr_onnxruntime) and restart the worker."); }
      return void store.setRecording(row.id, { scanned: 1 });
    }
    const { energy } = await readJson(join(row.dir, "energy.json"), { energy: [] });
    const chat = await readJson(join(row.dir, "chat.json"), []);
    const ranges = scanRanges({ energy, chat, duration: config?.duration ?? 45 });
    const scanStarted = Date.now();
    const events = ranges.length ? await screenText(file, { python, ranges, signal, scratch: join(row.dir, "screen") }) : [];
    console.log("Recording", row.id.slice(0, 8) + ": screen read in", Math.round((Date.now() - scanStarted) / 1000) + "s (" + ranges.length + " stretches)");
    await writeFile(join(row.dir, "screen.json"), JSON.stringify(events));
    const signals = await readJson(join(row.dir, "signals.json"), null);
    if (signals) await writeFile(join(row.dir, "signals.json"), JSON.stringify({ ...signals, moments: suggestions(energy, chat, events) }));
    store.setRecording(row.id, { scanned: 1, reported: 0 });
    void syncRecordings();
    console.log("Recording", row.id.slice(0, 8) + ":", events.length ? "game text on screen: " + [...new Set(events.map(e => e.text))].join(", ") : "no game banners found on screen");
    return;
  }
  if (!row.transcribed) return void await transcribePiece(row, file, signal);
  if (!row.rated) await aiPass(row, signal);
}

// ---- The full pass after a stream (stream-pass.mjs) ----
// With the whole transcript there, the AI scores every clip-length window of the stream, AI_BATCH windows per
// background pass (progress in ai-pass.json, so a restart resumes). Then its best windows join the pick list
// (signals.json moments, with its titles as reasons), and for record-only streams the ones rated AI_AUTO_CLIP+ that
// weren't clipped yet become clips, within the daily limit. If the AI keeps not answering, it finishes with what it has.
async function aiPass(row, signal) {
  const stateFile = join(row.dir, "ai-pass.json"), duration = config?.duration ?? 45, total = row.duration ?? 0;
  if (!pickerEnabled() || !config) return void store.setRecording(row.id, { rated: 1 });
  const { lines = [] } = await readJson(join(row.dir, "transcript.json"), {});
  const state = await readJson(stateFile, null) ?? { windows: transcriptWindows(lines, { duration, total, skip: total > duration * 4 + 60 ? 60 : 0 }), rated: [], misses: 0 };
  if (state.rated.length < state.windows.length && state.misses < 3) {
    const batch = state.windows.slice(state.rated.length, state.rated.length + AI_BATCH);
    const who = config.streamers.find(s => s.id === row.streamer), started = Date.now();
    const scores = await rateSegments(batch.map(w => w.text), { streamer: who ? streamerInfo(who.url).name : "", title: row.title ?? "" }, { signal });
    if (!scores) { state.misses++; await writeFile(stateFile, JSON.stringify(state)); throw new Error("the AI didn't score this part of the stream (is Ollama running?)"); }
    batch.forEach((w, i) => state.rated.push({ start: w.start, end: w.end, score: scores[i].score, title: scores[i].title }));
    await writeFile(stateFile, JSON.stringify(state));
    console.log("Recording", row.id.slice(0, 8) + ": AI read", state.rated.length, "of", state.windows.length, "stretches (" + Math.round((Date.now() - started) / 1000) + "s)");
    return;
  }
  const signals = await readJson(join(row.dir, "signals.json"), null);
  if (signals) await writeFile(join(row.dir, "signals.json"), JSON.stringify({ ...signals, moments: mergeAiMoments(signals.moments, state.rated) }));
  store.setRecording(row.id, { rated: 1, reported: 0 });
  void syncRecordings();
  const strong = state.rated.filter(r => r.score >= 8).length;
  console.log("Recording", row.id.slice(0, 8) + ": AI pass done,", state.rated.length, "stretches read,", strong, "rated 8+");
  // Record-only streams: the AI's best moments that nothing clipped yet (live captures of "both" streams aren't
  // tracked against the recording, so those only get the pick list).
  if (row.mode !== "record") return;
  const room = Math.max(0, limitFor(config, row.streamer) - store.countToday(row.streamer));
  const clipped = await readJson(join(row.dir, "clipped.json"), []);
  for (const pick of autoClipPicks(state.rated, clipped, { max: Math.min(5, room) })) {
    try { await clipFromRecording(row, pick.start, pick.end, { reason: "best", exact: false, tracker: null }); }
    catch (error) { problem("Could not cut the AI's moment from recording " + row.id.slice(0, 8) + ": " + error.message); }
  }
}

// ---- Searching recordings by what was said ----
// The whole recording is transcribed in TRANSCRIPT_PIECE-second pieces, one per background pass (so other work and
// a worker restart don't lose much), into transcript.json { upto, lines: [[start, end, text]] }; then it is uploaded
// for the Recordings page's search. WHISPER_SEARCH_MODEL (default "base") is faster than the clips' "small" model:
// search needs the words, not perfect punctuation.
const TRANSCRIPT_PIECE = 600;
async function transcribePiece(row, file, signal) {
  const out = join(row.dir, "transcript.json"), done = await readJson(out, { upto: 0, lines: [] }), total = row.duration ?? 0;
  if (done.upto < total - 1) {
    const from = done.upto, piece = join(row.dir, "piece.wav"), words = join(row.dir, "piece.json");
    try {
      await command("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(from), "-t", String(TRANSCRIPT_PIECE), "-i", file, "-vn", "-ac", "1", "-ar", "16000", piece], { signal, timeout: 5 * 60_000 }).done;
      const hint = [config?.streamers.find(s => s.id === row.streamer) && streamerInfo(config.streamers.find(s => s.id === row.streamer).url).name, row.title].filter(Boolean).join(". ");
      const pieceStarted = Date.now();
      await whisper(piece, words, { hint, python, signal, timeout: 60 * 60_000, model: process.env.WHISPER_SEARCH_MODEL || "base" });
      console.log("Recording", row.id.slice(0, 8) + ": 10 minutes transcribed in", Math.round((Date.now() - pieceStarted) / 1000) + "s");
      const { segments } = await readJson(words, { segments: [] });
      for (const seg of segments ?? []) {
        const text = (seg.words ?? []).map(w => String(w[2]).trim()).join(" ").replace(/\s+/g, " ").trim();
        if (text) done.lines.push([Math.round((from + seg.start) * 10) / 10, Math.round((from + seg.end) * 10) / 10, text.slice(0, 1000)]);
      }
    } finally { await rm(piece, { force: true }); await rm(words, { force: true }); }
    done.upto = Math.min(total, from + TRANSCRIPT_PIECE);
    await writeFile(out, JSON.stringify(done));
    console.log("Recording", row.id.slice(0, 8) + ": transcribed", Math.round(done.upto / 60), "of", Math.round(total / 60), "minutes for search");
    return;
  }
  const response = await api("/api/worker/recordings/" + row.id + "/transcript", { method: "PUT", body: JSON.stringify({ lines: done.lines }), timeout: 120_000 });
  // 404: the recording was deleted in the dashboard; 501: no storage there. Either way, nothing more to do.
  if (!response.ok && response.status !== 404 && response.status !== 501) throw new Error("transcript upload HTTP " + response.status);
  store.setRecording(row.id, { transcribed: 1 });
  console.log("Recording", row.id.slice(0, 8) + ":", response.ok ? "transcript uploaded (" + done.lines.length + " lines): it can be searched now" : "transcript not stored (HTTP " + response.status + ")");
}

// The pick list's suggested moments: clip-length windows of the recording, best first (the first minute of a long
// stream is skipped, like the automatic best moments).
let screenTextWarned = false;
function suggestions(energy, chat, events) {
  const duration = config?.duration ?? 45;
  return suggestMoments({ energy, chat, events, duration, count: 12, skip: energy.length > duration * 4 + 60 ? 60 : 0 });
}

// Uploads the preview to R2 through the dashboard in fixed-size parts. False when the dashboard has no storage.
async function uploadPreview(row, path) {
  const size = (await stat(path)).size, list = parts(size), base = "/api/worker/recordings/" + row.id + "/preview";
  const handle = await open(path);
  try {
    for (const p of list) {
      const body = Buffer.alloc(p.length);
      await handle.read(body, 0, p.length, p.offset);
      const response = await api(base, { method: "PUT", body, headers: { "content-type": "application/octet-stream", "x-part": String(p.number), "x-parts": String(list.length) }, timeout: 600_000 });
      if (response.status === 501) return false;
      if (response.status === 404) return true;  // recording deleted in the dashboard meanwhile
      if (!response.ok) throw new Error("preview upload HTTP " + response.status + " (part " + p.number + " of " + list.length + ")");
    }
  } finally { await handle.close(); }
  const done = await api(base, { method: "POST", body: JSON.stringify({ parts: list.length, size }) });
  if (!done.ok && done.status !== 404) throw new Error("preview completion HTTP " + done.status);
  return true;
}

// The last keyframe at or before `t` seconds, so a copied (not re-encoded) cut starts exactly where expected.
async function keyframeBefore(file, t) {
  try {
    const { stdout } = await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-skip_frame", "nokey", "-show_entries", "frame=pts_time:format=start_time", "-of", "json", "-read_intervals", Math.max(0, t - 20) + "%" + (t + 1), file], { timeout: 60_000, windowsHide: true, maxBuffer: 1 << 20 });
    const json = JSON.parse(stdout), offset = Number(json.format?.start_time) || 0;
    const keys = (json.frames ?? []).map(f => Number(f.pts_time) - offset).filter(k => Number.isFinite(k) && k <= t + 0.01);
    return keys.length ? Math.max(0, Math.max(...keys)) : Math.max(0, t - 20);
  } catch { return Math.max(0, t - 20); }
}

// Queues one clip of [start, end] seconds of a recording. `exact`: exactly that range; otherwise the usual window
// search and sentence snapping run around it.
async function clipFromRecording(row, start, end, { reason, exact, tracker }) {
  const settings = config, file = recordingFile(row);
  const streamer = settings.streamers.find(s => s.id === row.streamer) ?? { id: row.streamer, url: "removed streamer" };
  const id = crypto.randomUUID(), dir = join(dataDir, "clips", row.streamer, id), raw = join(dir, "window.m2t");
  const from = await keyframeBefore(file, Math.max(0, start - RECORDING_PAD)), to = Math.min(row.duration ?? Infinity, end + RECORDING_PAD);
  const length = Math.round(end - start);
  // What has been clipped from this recording, so the AI pass doesn't clip the same moment again.
  const clippedFile = join(row.dir, "clipped.json");
  await writeFile(clippedFile, JSON.stringify([...await readJson(clippedFile, []), { start, end }])).catch(() => {});
  store.add(id, row.streamer, join(dir, "clip.mp4"), exact ? length : settings.duration, textOf(settings, row.streamer).subtitles, reason);
  try {
    await mkdir(dir, { recursive: true });
    await extractRange(file, from, to, raw, backgroundController.signal);
  } catch (error) {
    store.fail(id);
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  const chat = await readJson(join(row.dir, "chat.json"), []);
  const style = streamer.style ?? settings.style ?? null;
  jobs.push({ queuedAt: Date.now(), id, dir, raw, streamer, settings: exact ? { ...settings, duration: length } : settings, style, reason, fromRecording: true, exact, tracker,
    chat: Array.from({ length: Math.ceil(to - from) + 10 }, (_, i) => chat[Math.floor(from) + i] ?? 0), focusFrom: start - from, focusTo: end - from });
  void processJobs();
}

// Picks and queues the `count` best moments of a recording. Returns how many were queued.
async function clipBestMoments(row, count, tracker) {
  const { energy } = await readJson(join(row.dir, "energy.json"), { energy: [] });
  const chat = await readJson(join(row.dir, "chat.json"), []);
  const duration = config.duration;
  // The first minute is skipped when the stream is long enough: it's usually a "starting soon" screen.
  const starts = pickMoments({ energy, chat, duration, count, skip: energy.length > duration * 4 + 60 ? 60 : 0 });
  if (tracker) tracker.left = starts.length;
  for (const s of starts) {
    try { await clipFromRecording(row, s, s + duration, { reason: "best", exact: false, tracker }); }
    catch (error) { if (tracker) settleRequest(tracker, false, error.message); else problem("Could not cut a moment from recording " + row.id.slice(0, 8) + ": " + error.message); }
  }
  return starts.length;
}

function reportRequest(id, body) {
  return api("/api/worker/recordings", { method: "POST", body: JSON.stringify({ op: "request", id, ...body }) }).catch(error => console.warn("Clip request report deferred:", error.message));
}

// One clip of a request finished (or failed); the request is done once all of them have.
function settleRequest(tracker, made, why) {
  tracker.left--;
  if (made) tracker.made++; else if (why) tracker.errors.push(why);
  if (tracker.left > 0) return;
  void reportRequest(tracker.id, tracker.made ? { state: "done", clips: tracker.made } : { state: "failed", error: String(tracker.errors[0] ?? "No clip could be made").slice(0, 300) });
}

// Clips asked for in the dashboard from a recording: one picked moment, or the best few.
async function takeRequests(list) {
  for (const r of list ?? []) {
    if (requestsSeen.has(r.id)) continue;
    const row = store.recording(r.recordingId);
    if (!row || row.state === "failed") {
      requestsSeen.add(r.id);
      void reportRequest(r.id, { state: "failed", error: row ? "This recording failed, so it can't be clipped." : "This recording is no longer on the worker PC (it may have passed its retention period)." });
      continue;
    }
    if (row.state !== "ready") continue;  // still recording or being saved: asked again next cycle
    requestsSeen.add(r.id);
    await reportRequest(r.id, { state: "working" });
    const tracker = { id: r.id, left: 1, made: 0, errors: [] };
    try {
      if (r.kind === "moment") await clipFromRecording(row, r.start, Math.min(r.end, row.duration ?? r.end), { reason: "manual", exact: true, tracker });
      else if (!await clipBestMoments(row, r.count, tracker)) void reportRequest(r.id, { state: "failed", error: "The recording is too short for a clip that long." });
    } catch (error) { settleRequest(tracker, false, error.message); }
  }
}

// Deletes recordings past the workspace's retention, and ones deleted in the dashboard.
async function pruneRecordings() {
  if (!config) return;
  const cutoff = Date.now() - config.recordingDays * 86_400_000;
  for (const row of store.recordings()) {
    if (row.state === "recording" || row.id === backgroundRow || row.id === videoDownload?.id) continue;
    const expired = Date.parse(row.started_at) < cutoff, deleted = config.recordings !== null && row.reported && !config.recordings.includes(row.id);
    if (!expired && !deleted) continue;
    // A file still open (a clip being cut from it) can't be removed on Windows; try again next cycle.
    try { await rm(row.dir, { recursive: true, force: true }); } catch { continue; }
    store.removeRecording(row.id);
    console.log("Removed recording", row.id.slice(0, 8), expired ? "(retention period ended)" : "(deleted in the dashboard)");
  }
}

// The split-screen background for a clip ({ path, start }), downloaded the first time it is needed. Null when the
// clip isn't split screen or the library is empty; a background that can't be fetched falls back to the blurred
// fill rather than failing the clip.
// The streamer's webcam overlay in a clip's source (fractions of the frame), or null. Uses OpenCV's YuNet face model,
// downloaded once into the models folder. Never fails a clip: no OpenCV, no model or no overlay all give null.
const FACE_MODEL_URL = "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx";
const faceModel = join(env.WHISPER_DIR || join(dataDir, "models"), "face_detection_yunet_2023mar.onnx");
let faceModelReady = null;
async function findFacecam(source, signal) {
  faceModelReady ??= (async () => {
    if ((await stat(faceModel).catch(() => null))?.size > 100_000) return true;
    const response = await fetch(FACE_MODEL_URL, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error("face model download HTTP " + response.status);
    await mkdir(dirname(faceModel), { recursive: true });
    await writeFile(faceModel, Buffer.from(await response.arrayBuffer()));
    return true;
  })().catch(error => { faceModelReady = null; console.warn("Facecam detection unavailable:", error.message); return false; });
  if (!await faceModelReady) return null;
  const out = source.replace(/\.mp4$/, "") + ".face.json";
  try {
    await command(python, [fileURLToPath(new URL("./facecam.py", import.meta.url)), source, out, faceModel], { signal, timeout: 60_000 }).done;
    return (await readJson(out, null))?.box ?? null;
  } catch { return null; } finally { await rm(out, { force: true }); }
}

// `title`: the stream title, for backgrounds named after what's being streamed. A library background picked here is
// returned as `ref` so the clip keeps it (it's pinned into the clip's edit).
async function backgroundFor(edit, clipId, title = "") {
  const pinned = !!edit.frame.background;
  const entry = chooseBackground(edit, clipId, config?.backgrounds, edit.trim.end - edit.trim.start, { lastUsed: store.backgroundUse(), title });
  if (!entry) return null;
  try {
    const path = await localBackground(dataDir, entry, async e => {
      // Another gallery clip: its unframed source, from this worker if it still has it, else from the dashboard.
      if (e.kind === "clip") {
        const local = store.get(e.clip), file = local && join(dirname(local.path), "source.mp4");
        if (file && await access(file).then(() => true, () => false)) return readFile(file);
      }
      const response = await api(e.kind === "clip" ? "/api/worker/clips/" + e.clip + "/source" : "/api/worker/backgrounds/" + e.id, { timeout: 300_000 });
      if (!response.ok) throw new Error("HTTP " + response.status);
      return Buffer.from(await response.arrayBuffer());
    });
    if (entry.kind !== "clip" && !pinned) store.usedBackground(entry.id);
    const ref = entry.kind === "clip" ? undefined : entry.id;
    // A still image is shown for the whole clip; a video starts at a spot of its own for each clip.
    if (entry.kind === "image") return { path, start: 0, image: true, ref };
    const info = await videoInfo(path);
    return { path, start: backgroundStart(clipId, info.duration, edit.trim.end - edit.trim.start), ref };
  } catch (error) {
    problem("Split-screen background unavailable for clip " + clipId + "; used the blurred fill instead: " + error.message);
    return null;
  }
}

// Re-renders a clip with an edit saved in the dashboard editor and uploads the result in place of the old file.
async function rerender(job) {
  const controller = new AbortController();
  const untrack = track(job, controller);
  const local = store.get(job.id), localSource = local && join(dirname(local.path), "source.mp4");
  const scratch = join(dataDir, "renders", job.id);
  try {
    let source = localSource;
    if (!source || !await access(source).then(() => true, () => false)) {
      // The worker no longer has this clip (pruned or captured elsewhere): fetch the source the dashboard stored.
      await mkdir(scratch, { recursive: true });
      const response = await api("/api/worker/clips/" + job.id + "/source", { timeout: 180_000 });
      if (!response.ok) throw new Error("source download HTTP " + response.status);
      source = join(scratch, "source.mp4");
      await writeFile(source, Buffer.from(await response.arrayBuffer()));
    }
    await mkdir(scratch, { recursive: true });
    const info = job.source?.width ? job.source : await videoInfo(source, controller.signal);
    const edit = normalizeEdit(job.edit, { duration: info.duration || job.source?.duration || 600 });
    const out = join(scratch, "render-" + job.rev + ".mp4");
    const result = await renderClip(source, { edit, words: job.edit.words ?? job.words ?? [], width: info.width, height: info.height, background: await backgroundFor(edit, job.id), energy: job.signals?.energy ?? null, messages: job.signals?.messages ?? [] }, out, controller.signal);
    // The clip's length after jump cuts, which can be shorter than its trim.
    const upload = await api("/api/worker/clips/" + job.id + "/render", { method: "PUT", body: await readFile(out), headers: { "content-type": "video/mp4", "x-edit-rev": String(job.rev), "x-clip-sha256": result.sha, "x-clip-duration": String(result.duration) }, timeout: 180_000 });
    // 409: the clip was edited again meanwhile; the newer revision arrives with the next config poll.
    if (!upload.ok && upload.status !== 409) throw new Error("upload HTTP " + upload.status);
    console.log("Re-rendered clip", job.id, "(edit " + job.rev + ", " + result.duration + "s)");
  } catch (error) {
    if (!controller.signal.aborted) {
      problem("Re-render failed for clip " + job.id + ": " + error.message);
      await api("/api/worker/clips/" + job.id + "/render", { method: "POST", body: JSON.stringify({ rev: job.rev, error: String(error.message).slice(0, 300) }) }).catch(() => {});
    } else renderRevs.delete(job.id);
  } finally {
    untrack();
    await rm(scratch, { recursive: true, force: true });
  }
}

// ---- Highlight videos ----
// The clips' moments, cut from their unframed sources (this PC's copy, else the one the dashboard stored) and joined
// into one 16:9 video (highlights-video.mjs), uploaded in parts like a recording's preview.
const highlightsQueued = new Set();
function queueHighlights(list) {
  for (const h of list ?? []) {
    if (highlightsQueued.has(h.id)) continue;
    highlightsQueued.add(h.id);
    jobs.push({ queuedAt: Date.now(), kind: "highlight", ...h });
  }
  if (jobs.length) void processJobs();
}
async function highlightJob(job) {
  const controller = new AbortController(), scratch = join(dataDir, "highlights", job.id), base = "/api/worker/highlights/" + job.id;
  const untrack = track(job, controller);
  try {
    await rm(scratch, { recursive: true, force: true });
    await mkdir(scratch, { recursive: true });
    const pieces = [];
    for (const [i, c] of job.clips.entries()) {
      const local = store.get(c.id), mine = local && join(dirname(local.path), "source.mp4");
      let source = mine && await access(mine).then(() => true, () => false) ? mine : null;
      if (!source) {
        const response = await api("/api/worker/clips/" + c.id + "/source", { timeout: 180_000 });
        if (!response.ok) { console.warn("Highlight " + job.id.slice(0, 8) + ": skipping clip " + c.id + " (source HTTP " + response.status + ")"); continue; }
        source = join(scratch, "source-" + i + ".mp4");
        await writeFile(source, Buffer.from(await response.arrayBuffer()));
      }
      pieces.push({ source, start: c.start, end: c.end });
    }
    if (pieces.length < 2) throw new Error("fewer than 2 of its clips could be found");
    const out = join(scratch, "highlights.mp4");
    const { duration } = await makeHighlightVideo(pieces, out, { dir: scratch, signal: controller.signal });
    const size = (await stat(out)).size, list = parts(size), handle = await open(out);
    try {
      for (const p of list) {
        const body = Buffer.alloc(p.length);
        await handle.read(body, 0, p.length, p.offset);
        const response = await api(base, { method: "PUT", body, headers: { "content-type": "application/octet-stream", "x-part": String(p.number), "x-parts": String(list.length) }, timeout: 600_000 });
        if (response.status === 404) return;  // deleted in the dashboard meanwhile
        if (!response.ok) throw new Error("upload HTTP " + response.status + " (part " + p.number + " of " + list.length + ")");
      }
    } finally { await handle.close(); }
    const done = await api(base, { method: "POST", body: JSON.stringify({ parts: list.length, size, duration }) });
    if (!done.ok && done.status !== 404) throw new Error("completion HTTP " + done.status);
    console.log("Made highlight video", job.id.slice(0, 8), "from", pieces.length, "clips (" + Math.round(duration) + "s)");
  } catch (error) {
    if (!controller.signal.aborted) {
      problem("Couldn't make highlight video " + job.id.slice(0, 8) + ": " + error.message);
      await api(base, { method: "POST", body: JSON.stringify({ error: String(error.message).slice(0, 300) }) }).catch(() => {});
    } else highlightsQueued.delete(job.id);
  } finally {
    untrack();
    await rm(scratch, { recursive: true, force: true });
  }
}

// ---- Clips in another language ----
// An account set to post in Spanish, Portuguese or French gets its own version of each clip: the subtitles (sentence
// by sentence, timed over the original speech), the hook and the post caption translated by the local AI model, then
// rendered from the clip's current edit and uploaded. If it can't be made, the dashboard is told why and the post
// fails rather than going out in English.
const translateRevs = new Map();  // "<clip>:<lang>" -> edit revision queued
function queueTranslations(list) {
  for (const t of list ?? []) {
    const key = t.id + ":" + t.lang;
    if ((translateRevs.get(key) ?? -1) >= t.rev) continue;
    translateRevs.set(key, t.rev);
    jobs.push({ queuedAt: Date.now(), kind: "translate", ...t });
  }
  if (jobs.length) void processJobs();
}
async function translateJob(job) {
  const controller = new AbortController(), name = LANGUAGE_NAMES[job.lang];
  const untrack = track(job, controller);
  const local = store.get(job.id), localSource = local && join(dirname(local.path), "source.mp4");
  const scratch = join(dataDir, "renders", job.id + "-" + job.lang);
  try {
    let source = localSource;
    if (!source || !await access(source).then(() => true, () => false)) {
      await mkdir(scratch, { recursive: true });
      const response = await api("/api/worker/clips/" + job.id + "/source", { timeout: 180_000 });
      if (!response.ok) throw new Error("source download HTTP " + response.status);
      source = join(scratch, "source.mp4");
      await writeFile(source, Buffer.from(await response.arrayBuffer()));
    }
    await mkdir(scratch, { recursive: true });
    const info = job.source?.width ? job.source : await videoInfo(source, controller.signal);
    const base = normalizeEdit(job.edit, { duration: info.duration || job.source?.duration || 600 });
    // Only what's said inside the trim (and a second either side) needs translating.
    const words = (job.edit.words ?? job.words ?? []).filter(w => w[1] >= base.trim.start - 1 && w[0] <= base.trim.end + 1);
    const sentences = sentencesOf(words);
    // The streamer's name stays as it is: names like "Speed" would otherwise be translated.
    const names = [job.streamer].filter(Boolean);
    const out = await translateClip({ sentences, hook: base.hook.text, caption: job.caption ?? "", names }, job.lang, { signal: controller.signal });
    if (!out) throw new Error("the AI model didn't translate it (is Ollama running on the worker PC?)");
    const translatedWords = sentences.flatMap((s, i) => spreadWords(s, out.sentences[i]));
    const edit = { ...base, hook: { ...base.hook, text: base.hook.text ? out.hook : "" } };
    const file = join(scratch, "render-" + job.lang + "-" + job.rev + ".mp4");
    const result = await renderClip(source, { edit, words: translatedWords, width: info.width, height: info.height, background: await backgroundFor(edit, job.id), energy: job.signals?.energy ?? null, messages: job.signals?.messages ?? [] }, file, controller.signal);
    const upload = await api("/api/worker/clips/" + job.id + "/translation", { method: "PUT", body: await readFile(file), timeout: 180_000,
      headers: { "content-type": "video/mp4", "x-lang": job.lang, "x-rev": String(job.rev), "x-clip-sha256": result.sha, ...(out.caption && { "x-caption": encodeURIComponent(out.caption) }) } });
    // 409: no longer wanted (the clip was edited again, or the account changed language).
    if (!upload.ok && upload.status !== 409) throw new Error("upload HTTP " + upload.status);
    console.log("Made the", name, "version of clip", job.id, "(" + sentences.length + " lines translated)");
  } catch (error) {
    if (!controller.signal.aborted) {
      problem("Couldn't make the " + name + " version of clip " + job.id + ": " + error.message);
      await api("/api/worker/clips/" + job.id + "/translation", { method: "POST", body: JSON.stringify({ lang: job.lang, rev: job.rev, error: String(error.message).slice(0, 300) }) }).catch(() => {});
    } else translateRevs.delete(job.id + ":" + job.lang);
  } finally {
    untrack();
    await rm(scratch, { recursive: true, force: true });
  }
}

function queueRenders(list) {
  for (const r of list ?? []) {
    if ((renderRevs.get(r.id) ?? -1) >= r.rev) continue;
    renderRevs.set(r.id, r.rev);
    // A newer revision replaces a waiting older one.
    const waiting = jobs.findIndex(j => j.kind === "render" && j.id === r.id);
    if (waiting >= 0) jobs.splice(waiting, 1);
    jobs.push({ queuedAt: Date.now(), kind: "render", ...r });
  }
  if (jobs.length) void processJobs();
}

async function readMeta(path) {
  try { return JSON.parse(await readFile(join(dirname(path), "meta.json"), "utf8")); } catch { return null; }
}

// Sends finished clips in the background, one pass at a time: uploads can take minutes each on a slow connection,
// and the cycle (live checks, starting recordings) must not wait for them. A call during a pass asks for another
// pass after it, so a clip finished meanwhile goes out without waiting for the next cycle; two passes never run at
// once (both would send the same pending clips).
let reporting = null, reportAgain = false;
function report() {
  if (reporting) { reportAgain = true; return reporting; }
  reporting = (async () => {
    do { reportAgain = false; await reportPass(); } while (reportAgain && !stopping);
  })().catch(error => problem("Sending clips failed: " + error.message)).finally(() => { reporting = null; });
  return reporting;
}

async function reportPass() {
  for (const row of store.pending()) {
    if (stopping) return;
    let size;
    try { size = (await stat(row.path)).size; } catch { store.fail(row.id); continue; }
    try {
      const permanent = status => status >= 400 && status < 500 && status !== 401 && status !== 429;
      // The editor's material: the first edit, transcript, heat strip and the source's size and hash.
      const meta = await readMeta(row.path);
      const extra = meta ? { edit: meta.edit, transcript: meta.words, signals: meta.signals, source: { ...meta.source, sha: meta.sourceSha, size: meta.sourceSize }, ...(meta.postCaption && { postCaption: meta.postCaption }) } : {};
      const response = await api("/api/worker/clips", { method: "POST", body: JSON.stringify({ id: row.id, streamerId: row.streamer, createdAt: row.created_at, duration: row.duration, captions: !!row.captions, sha: row.sha, size, ...(row.reason && { reason: row.reason }), ...extra }) });
      // 4xx other than auth and rate limiting will not succeed on retry (for example a removed streamer).
      if (permanent(response.status)) { store.rejected(row.id); problem("Dashboard refused clip " + row.id + " (HTTP " + response.status + ")"); continue; }
      if (!response.ok) throw new Error("HTTP " + response.status);
      // Both steps are idempotent server-side, so a retry after a failed upload safely repeats the report.
      const uploadStarted = Date.now();
      const upload = await api("/api/worker/clips/" + row.id + "/file", { method: "PUT", body: await readFile(row.path), headers: { "content-type": "video/mp4" }, timeout: 180_000 });
      if (upload.status === 501) { store.uploaded(row.id); console.log("Clip reported; dashboard storage is off, file kept locally:", row.id); continue; }
      else if (upload.ok) { store.uploaded(row.id); console.log("Clip uploaded:", row.id, "(" + Math.round((Date.now() - uploadStarted) / 100) / 10 + "s)"); }
      else if (permanent(upload.status)) { store.rejected(row.id); problem("Dashboard refused the file for clip " + row.id + " (HTTP " + upload.status + ")"); continue; }
      else throw new Error("upload HTTP " + upload.status);
      // The source lets the clip be edited after this machine has pruned it. Not fatal: without it the clip
      // can still be edited here until the retention period ends.
      if (meta) {
        const sent = await api("/api/worker/clips/" + row.id + "/source", { method: "PUT", body: await readFile(join(dirname(row.path), "source.mp4")), headers: { "content-type": "video/mp4" }, timeout: 300_000 }).catch(error => ({ ok: false, status: error.message }));
        if (!sent.ok) problem("Could not store the editable source for clip " + row.id + " (" + sent.status + "); it can be edited while this machine keeps it.");
      }
    } catch (error) {
      store.retry(row.id, row.attempts + 1);
      problem("Could not send clip " + row.id + " to the dashboard, will retry: " + error.message);
    }
  }
}

async function prune() {
  await trimFailures();
  const cutoff = new Date(Date.now() - tuning.retentionHours * 3600_000).toISOString();
  for (const row of store.old(cutoff)) {
    await rm(dirname(row.path), { recursive: true, force: true });
    store.remove(row.id);
  }
}

// Clips cut in the last day but not finished when the worker stopped (a restart, a crash) are processed now, from the
// raw window still on disk. Their chat isn't known any more, so they're placed by loudness and what was said.
let resumed = false;
async function resumeInterrupted() {
  if (resumed || !config) return;
  resumed = true;
  let count = 0;
  for (const row of store.interrupted(new Date(Date.now() - 86_400_000).toISOString())) {
    const dir = dirname(row.path), raw = join(dir, "window.m2t"), streamer = config.streamers.find(s => s.id === row.streamer);
    if (!streamer || !await access(raw).then(() => true, () => false)) continue;
    const exact = row.reason === "viewer" || row.reason === "manual";
    store.resume(row.id);
    jobs.push({ queuedAt: Date.now(), id: row.id, dir, raw, streamer, settings: config, style: streamer.style ?? config.style ?? null, reason: row.reason ?? "audio",
      exact, fromRecording: ["best", "manual"].includes(row.reason), focusFrom: 0, focusTo: Infinity, chat: [], chatLines: [], resumed: true });
    count++;
  }
  if (count) { console.log("Resuming", count, "clip(s) interrupted by the last stop"); void processJobs(); }
}

async function tick() {
  await refresh();
  if (restartIfIdle()) return;
  maybeCheckHealth();
  await resumeInterrupted();
  queueRenders(config?.renders);
  queueTranslations(config?.translations);
  queueHighlights(config?.highlights);
  if (config) await takeRequests(config.clipRequests);
  if (config) takeRetries(config.retries);
  // Stop disallowed recordings before the (slow) live checks rather than after them.
  for (const id of sessions.keys()) if (!allowed(config, id)) await stopSession(id, "paused, stopped or disabled");
  await probe(dueForProbe(config, live, { running: new Set(sessions.keys()), now: Date.now(), interval: liveCheckMs, limit: probesPerCycle }));
  const { start, bump } = plan(config, { running: new Set(sessions.keys()), blockedUntil, countToday: id => store.countToday(id), now: Date.now(), maxCaptures: tuning.maxCaptures, isLive });
  // A higher-priority streamer went live with every slot taken: the lowest-ranked capture ends to make room.
  for (const id of bump) await stopSession(id, "a higher-priority streamer went live");
  for (const streamer of start) await startSession(streamer);
  await importViewerClips();
  void makeViewerPicks().catch(error => problem("Making picked viewer clips failed: " + error.message));
  if (config) takeImports([...config.imports,...config.uploads.map(v=>({...v,uploaded:true}))]);
  await reportStatus();
  void report();
  await syncRecordings();
  await prune();
  await pruneRecordings();
  void runBackground();
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
  for (const r of running) r.controller.abort();
  stopTranscriber();
  backgroundController.abort();
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
