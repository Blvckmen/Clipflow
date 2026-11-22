import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { validBackgrounds } from "./backgrounds.mjs";
import { videoLink } from "./video-link.mjs";
import { hideQueries } from "./process.mjs";

export function channelUrl(value) {
  const u = new URL(value);
  const host = u.hostname.replace(/^www\./, "");
  if (u.protocol !== "https:" || u.username || u.password || u.port || u.search || u.hash) throw new Error("Invalid channel URL");
  const p = u.pathname.split("/").filter(Boolean);
  if (["twitch.tv","kick.com"].includes(host)) {
    if (p.length !== 1 || !/^[a-zA-Z0-9_][a-zA-Z0-9_-]{1,49}$/.test(p[0]) || ["directory","videos","clips","search","settings","downloads","subscriptions","following","browse"].includes(p[0].toLowerCase())) throw new Error("Invalid channel");
  } else if (host === "youtube.com") {
    if (!((p.length === 1 && /^@[\p{L}\p{N}_.-]{3,40}$/u.test(decodeURIComponent(p[0]))) || (p.length === 2 && p[0] === "channel" && /^UC[a-zA-Z0-9_-]{22}$/.test(p[1])))) throw new Error("Invalid YouTube channel");
    u.pathname = "/" + p.join("/") + "/live";
  } else if (host === "tiktok.com") {
    // streamlink's TikTok plugin reads the profile's live room.
    if (p.length !== 1 || !/^@[a-zA-Z0-9_.]{2,24}$/.test(p[0])) throw new Error("Invalid TikTok profile");
    u.pathname = "/" + p[0] + "/live";
  } else throw new Error("Unsupported channel host");
  return u.href;
}
// A streamer's transcription, subtitles and automatic hook: its own choice where it made one, else the workspace's
// (transcription and subtitles are workspace settings; automatic hooks are on). Subtitles and hooks are made from the
// transcript, so without transcription there are neither.
export function clipTextFor(settings, streamer) {
  const own = streamer?.text ?? {}, transcribe = own.transcribe ?? settings.transcribe !== false;
  return { transcribe, subtitles: transcribe && (own.subtitles ?? !!settings.captions), hook: transcribe && (own.hook ?? true) };
}
export function validateControl(c) {
  if (!c || !["running","paused","stopped"].includes(c.control) || !Array.isArray(c.streamers)) throw new Error("Invalid control response");
  if (c.streamers.length > 500) throw new Error("Too many channels");
  // Dashboards that predate the framing setting omit it.
  c.framing ??= "blur";
  // Dashboards that predate the transcribe setting omit it: transcribe, as before.
  c.transcribe ??= true;
  if (typeof c.transcribe !== "boolean") throw new Error("Invalid transcribe setting");
  if (!["blur","crop","fit","split","cam","pip","phone"].includes(c.framing)) throw new Error("Invalid framing");
  // Split-screen background videos in the workspace library; dashboards that predate them omit the list.
  c.backgrounds = validBackgrounds(c.backgrounds);
  if (!Number.isInteger(c.duration) || c.duration < 15 || c.duration > 90 || typeof c.captions !== "boolean" || !Number.isInteger(c.dailyLimit) || c.dailyLimit < 1 || c.dailyLimit > 100) throw new Error("Invalid clip settings");
  const ids = new Set();
  for (const s of c.streamers) {
    if (!/^[0-9a-f-]{36}$/i.test(s.id) || ids.has(s.id) || !["armed","paused","stopped"].includes(s.status)) throw new Error("Invalid streamer");
    if (s.style !== undefined && s.style !== null && typeof s.style !== "object") throw new Error("Invalid streamer style");
    // Dashboards that predate recording omit the capture mode: clip live, as before.
    s.captureMode ??= "clip";
    if (!["clip","record","both"].includes(s.captureMode)) throw new Error("Invalid capture mode");
    // This streamer's own transcription, subtitles and hook choices; dashboards that predate them omit the object.
    // Learned from views: how much chat counts against loudness when picking this streamer's moments.
    if (s.chatWeight !== undefined && !(typeof s.chatWeight === "number" && s.chatWeight >= 0.2 && s.chatWeight <= 0.8)) throw new Error("Invalid learned chat weight");
    s.text ??= {};
    if (typeof s.text !== "object" || Array.isArray(s.text) || Object.entries(s.text).some(([k, v]) => !["transcribe","subtitles","hook"].includes(k) || typeof v !== "boolean")) throw new Error("Invalid streamer text settings");
    channelUrl(s.url); ids.add(s.id);
  }
  // Viewers' Twitch clips: the fewest views a clip needs to be imported, 0 for off (and for older dashboards).
  // Who can clip with "!clip" in Twitch chat; dashboards that predate it get the default.
  c.clipCommand ??= "mods";
  if (!["off","mods","everyone"].includes(c.clipCommand)) throw new Error("Invalid chat command setting");
  c.importClips ??= 0;
  if (!Number.isInteger(c.importClips) || c.importClips < 0 || c.importClips > 100000) throw new Error("Invalid clip import setting");
  // The rest of the viewers' clips settings, the workspace's and each streamer's (see twitch.mjs viewerSettings, which
  // drops anything out of range); older dashboards send none.
  if (c.viewerClips !== undefined && (typeof c.viewerClips !== "object" || Array.isArray(c.viewerClips))) throw new Error("Invalid viewer clip settings");
  for (const s of c.streamers) if (s.viewerClips !== undefined && (typeof s.viewerClips !== "object" || Array.isArray(s.viewerClips))) throw new Error("Invalid streamer viewer clip settings");
  // Viewers' clips picked in the dashboard ("ask me first") to make now.
  c.viewerClipPicks ??= [];
  if (!Array.isArray(c.viewerClipPicks) || c.viewerClipPicks.length > 20) throw new Error("Invalid viewer clip picks");
  for (const v of c.viewerClipPicks) if (!/^[A-Za-z0-9_-]{1,100}$/.test(v?.id) || !/^[0-9a-f-]{36}$/i.test(v.streamerId) || !Number.isFinite(v.duration)) throw new Error("Invalid viewer clip pick");
  c.recordingDays ??= 7;
  if (!Number.isInteger(c.recordingDays) || c.recordingDays < 1 || c.recordingDays > 30) throw new Error("Invalid recording retention");
  // Recordings the dashboard still has (null: a dashboard that predates recording, so nothing is pruned for it),
  // and clips asked for from them.
  c.recordings ??= null;
  if (c.recordings !== null && (!Array.isArray(c.recordings) || c.recordings.some(id => !/^[0-9a-f-]{36}$/i.test(id)))) throw new Error("Invalid recordings");
  c.clipRequests ??= [];
  if (!Array.isArray(c.clipRequests) || c.clipRequests.length > 50) throw new Error("Invalid clip requests");
  for (const r of c.clipRequests) {
    if (!/^[0-9a-f-]{36}$/i.test(r?.id) || !/^[0-9a-f-]{36}$/i.test(r.recordingId) || !["moment","best"].includes(r.kind)) throw new Error("Invalid clip request");
    if (r.kind === "moment" && !(Number.isInteger(r.start) && Number.isInteger(r.end) && r.start >= 0 && r.end - r.start >= 15 && r.end - r.start <= 90)) throw new Error("Invalid clip request range");
    if (r.kind === "best" && !(Number.isInteger(r.count) && r.count >= 1 && r.count <= 20)) throw new Error("Invalid clip request count");
  }
  // Videos pasted on the Recordings page, waiting to be downloaded ({ id, streamerId, url }). Each link is rebuilt by
  // videoLink() and must come back the same; dashboards that predate imports omit the list.
  c.imports ??= [];
  if (!Array.isArray(c.imports) || c.imports.length > 20) throw new Error("Invalid imports");
  for (const v of c.imports) if (!/^[0-9a-f-]{36}$/i.test(v?.id) || !/^[0-9a-f-]{36}$/i.test(v.streamerId) || videoLink(v.url)?.url !== v.url) throw new Error("Invalid import");
  // Highlight videos to make: each a list of clips and the part of each to use; older dashboards send none.
  c.highlights ??= [];
  if (!Array.isArray(c.highlights) || c.highlights.length > 5) throw new Error("Invalid highlights");
  for (const h of c.highlights) if (!/^[0-9a-f-]{36}$/i.test(h?.id) || !Array.isArray(h.clips) || !h.clips.length || h.clips.length > 20
    || h.clips.some(x => !/^[0-9a-f-]{36}$/i.test(x?.id) || !Number.isFinite(x.start) || !Number.isFinite(x.end) || x.start < 0 || x.end <= x.start || x.end - x.start > 600)) throw new Error("Invalid highlight");
  // Clips to make in another language for accounts that post in it; older dashboards send none.
  c.translations ??= [];
  if (!Array.isArray(c.translations) || c.translations.length > 20) throw new Error("Invalid translations");
  for (const t of c.translations) if (!/^[0-9a-f-]{36}$/i.test(t?.id) || !["es", "pt", "fr"].includes(t.lang) || !Number.isInteger(t.rev) || t.rev < 0 || !t.edit || typeof t.edit !== "object") throw new Error("Invalid translation request");
  // Re-renders requested from the editor. Dashboards that predate the editor omit them.
  c.renders ??= [];
  if (!Array.isArray(c.renders) || c.renders.length > 20) throw new Error("Invalid renders");
  for (const r of c.renders) if (!/^[0-9a-f-]{36}$/i.test(r?.id) || !Number.isInteger(r.rev) || r.rev < 1 || !r.edit || typeof r.edit !== "object") throw new Error("Invalid render request");
  return c;
}
export function allowed(c, id) { return c?.control === "running" && c.streamers.some(s => s.id === id && s.status === "armed"); }
// Classifies `streamlink --json` output. Only "No playable streams" means offline; other errors are not proof either way.
export function probeResult(json) {
  if (json?.streams && typeof json.streams === "object" && Object.keys(json.streams).length) return { status: "live", title: typeof json.metadata?.title === "string" ? json.metadata.title.slice(0, 200) : null };
  if (typeof json?.error === "string" && /no playable streams/i.test(json.error)) return { status: "offline", title: null };
  return { status: "error", title: null, message: typeof json?.error === "string" ? hideQueries(json.error).slice(0, 300) : "no readable answer from streamlink" };
}
// Armed streamers whose last live check is older than `interval`, least recently checked first.
export function dueForProbe(c, live, { running, now, interval, limit }) {
  if (c?.control !== "running") return [];
  const checked = id => live.get(id)?.checkedAt ?? 0;
  return c.streamers.filter(s => s.status === "armed" && !running.has(s.id) && now - checked(s.id) >= interval).sort((a, b) => checked(a.id) - checked(b.id)).slice(0, limit);
}
// Decides which captures to cancel and which to begin. A null config (unreachable dashboard) cancels everything.
// c.streamers comes in recording-priority order (the dashboard sorts it). With every slot taken, a live streamer
// ranked higher than one being captured takes that capture's slot: `bump` lists the captures to end for it,
// lowest-ranked first.
export function plan(c, { running, blockedUntil, countToday, now, maxCaptures, isLive }) {
  const stop = [...running].filter(id => !allowed(c, id)), start = [], bump = [];
  if (c?.control !== "running") return { start, stop, bump };
  const rank = new Map(c.streamers.map((s, i) => [s.id, i]));
  const kept = [...running].filter(id => !stop.includes(id));
  let slots = maxCaptures - kept.length;
  for (const s of c.streamers) {
    // The daily limit only limits clipping: a streamer that is also recorded keeps being recorded.
    if (s.status !== "armed" || running.has(s.id) || !isLive(s.id) || (blockedUntil.get(s.id) ?? 0) > now || ((s.captureMode ?? "clip") === "clip" && countToday(s.id) >= c.dailyLimit)) continue;
    if (slots > 0) { start.push(s); slots--; continue; }
    const lower = kept.filter(id => !bump.includes(id) && rank.get(id) > rank.get(s.id)).sort((x, y) => rank.get(y) - rank.get(x));
    // Streamers further down the list rank lower still, so none of them can take a slot either.
    if (!lower.length) break;
    bump.push(lower[0]); start.push(s);
  }
  return { start, stop, bump };
}
export function retryDelay(attempt) { return Math.min(300_000, 30_000 * 2 ** Math.min(attempt, 4)); }
export function clipHash(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
export class Store {
  constructor(dir) {
    mkdirSync(dir,{recursive:true});this.db=new DatabaseSync(join(dir,"worker.sqlite"));
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("CREATE TABLE IF NOT EXISTS clips (id TEXT PRIMARY KEY, streamer TEXT NOT NULL, path TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, duration INTEGER NOT NULL, captions INTEGER NOT NULL, sha TEXT, attempts INTEGER NOT NULL DEFAULT 0, next_try INTEGER NOT NULL DEFAULT 0)");
    this.db.exec("CREATE INDEX IF NOT EXISTS clips_streamer_date ON clips(streamer,created_at)");
    // Added after the first release; older local databases gain the column on start.
    if (!this.db.prepare("PRAGMA table_info(clips)").all().some(c => c.name === "reason")) this.db.exec("ALTER TABLE clips ADD COLUMN reason TEXT");
    this.db.exec("UPDATE clips SET state='interrupted' WHERE state='capturing'");
    // Whole-stream recordings kept here. state: recording -> ended (segments on disk, to be joined) -> ready
    // (recording.mp4) | failed. step: what still has to happen once ready (measured, previewed, auto-clipped).
    this.db.exec("CREATE TABLE IF NOT EXISTS recordings (id TEXT PRIMARY KEY, streamer TEXT NOT NULL, dir TEXT NOT NULL, mode TEXT NOT NULL, state TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, duration REAL, title TEXT, error TEXT, reported INTEGER NOT NULL DEFAULT 0, previewed INTEGER NOT NULL DEFAULT 0, clipped INTEGER NOT NULL DEFAULT 0)");
    // A recording cut short by a worker restart is joined from whatever was written.
    this.db.exec("UPDATE recordings SET state='ended', ended_at=coalesce(ended_at, started_at) WHERE state='recording'");
    // scanned: its screen has been read for game banners. Recordings from before this was added are left as they are.
    if (!this.db.prepare("PRAGMA table_info(recordings)").all().some(c => c.name === "scanned")) this.db.exec("ALTER TABLE recordings ADD COLUMN scanned INTEGER NOT NULL DEFAULT 1");
    // transcribed: the whole recording has been transcribed for search (set to 0 when it becomes ready). Recordings
    // from before this was added aren't transcribed afterwards: a long one would keep the PC busy for hours.
    if (!this.db.prepare("PRAGMA table_info(recordings)").all().some(c => c.name === "transcribed")) this.db.exec("ALTER TABLE recordings ADD COLUMN transcribed INTEGER NOT NULL DEFAULT 1");
    // rated: the AI has read the whole transcript for the pick list (the full pass after a stream; set to 0 at ready).
    if (!this.db.prepare("PRAGMA table_info(recordings)").all().some(c => c.name === "rated")) this.db.exec("ALTER TABLE recordings ADD COLUMN rated INTEGER NOT NULL DEFAULT 1");
  }
  addRecording(id,streamer,dir,mode) { this.db.prepare("INSERT INTO recordings(id,streamer,dir,mode,state,started_at,scanned) VALUES (?,?,?,?,'recording',?,0)").run(id,streamer,dir,mode,new Date().toISOString()); }
  recording(id) { return this.db.prepare("SELECT * FROM recordings WHERE id=?").get(id)??null; }
  recordings() { return this.db.prepare("SELECT * FROM recordings ORDER BY started_at").all(); }
  setRecording(id,fields) { const keys=Object.keys(fields); this.db.prepare("UPDATE recordings SET "+keys.map(k=>k+"=?").join(",")+" WHERE id=?").run(...keys.map(k=>fields[k]),id); }
  removeRecording(id) { this.db.prepare("DELETE FROM recordings WHERE id=?").run(id); }
  // When each split-screen background was last used, so new clips rotate through the library.
  backgroundUse() { this.db.exec("CREATE TABLE IF NOT EXISTS background_use (id TEXT PRIMARY KEY, used_at INTEGER NOT NULL)"); return new Map(this.db.prepare("SELECT id,used_at FROM background_use").all().map(r => [r.id, r.used_at])); }
  usedBackground(id, at = Date.now()) { this.db.exec("CREATE TABLE IF NOT EXISTS background_use (id TEXT PRIMARY KEY, used_at INTEGER NOT NULL)"); this.db.prepare("INSERT INTO background_use (id,used_at) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET used_at=excluded.used_at").run(id, at); }
  add(id,streamer,path,duration,captions,reason=null) { this.db.prepare("INSERT INTO clips(id,streamer,path,state,created_at,duration,captions,reason) VALUES (?,?,?,'capturing',?,?,?,?)").run(id,streamer,path,new Date().toISOString(),duration,Number(captions),reason); }
  // Sentence snapping makes the final length differ slightly from the configured one.
  ready(id,sha,duration) {this.db.prepare("UPDATE clips SET state='ready',sha=?,duration=coalesce(?,duration) WHERE id=?").run(sha,duration??null,id);}
  fail(id) {this.db.prepare("UPDATE clips SET state='failed' WHERE id=?").run(id);}
  uploaded(id) {this.db.prepare("UPDATE clips SET state='uploaded' WHERE id=?").run(id);}
  rejected(id) {this.db.prepare("UPDATE clips SET state='rejected' WHERE id=?").run(id);}
  retry(id,attempt) {this.db.prepare("UPDATE clips SET attempts=?,next_try=? WHERE id=?").run(attempt,Date.now()+retryDelay(attempt),id);}
  get(id) {return this.db.prepare("SELECT * FROM clips WHERE id=?").get(id)??null;}
  pending() {return this.db.prepare("SELECT * FROM clips WHERE state='ready' AND next_try<=? ORDER BY created_at LIMIT 10").all(Date.now());}
  // Clips cut but not finished when the worker last stopped (marked interrupted on start), newest first.
  interrupted(sinceIso, limit = 30) {return this.db.prepare("SELECT * FROM clips WHERE state='interrupted' AND created_at>=? ORDER BY created_at DESC LIMIT ?").all(sinceIso, limit);}
  resume(id) {this.db.prepare("UPDATE clips SET state='capturing' WHERE id=? AND state='interrupted'").run(id);}
  // Today's clips toward the daily limit. Viewers' Twitch clips don't count: they have their own cap (countViewerToday).
  countToday(streamer) {return this.db.prepare("SELECT count(*) AS n FROM clips WHERE streamer=? AND created_at>=? AND state IN ('capturing','ready','uploaded') AND coalesce(reason,'')<>'viewer'").get(streamer,new Date().toISOString().slice(0,10)).n;}
  countViewerToday(streamer) {return this.db.prepare("SELECT count(*) AS n FROM clips WHERE streamer=? AND created_at>=? AND state IN ('capturing','ready','uploaded') AND reason='viewer'").get(streamer,new Date().toISOString().slice(0,10)).n;}
  old(before) {return this.db.prepare("SELECT * FROM clips WHERE created_at<? AND state!='capturing'").all(before);}
  remove(id) {this.db.prepare("DELETE FROM clips WHERE id=?").run(id);}
  close() {this.db.close();}
}
