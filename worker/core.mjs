import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

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
  } else throw new Error("Unsupported channel host");
  return u.href;
}
export function validateControl(c) {
  if (!c || !["running","paused","stopped"].includes(c.control) || !Array.isArray(c.streamers)) throw new Error("Invalid control response");
  if (c.streamers.length > 500) throw new Error("Too many channels");
  // Dashboards that predate the framing setting omit it.
  c.framing ??= "blur";
  if (!["blur","crop","fit"].includes(c.framing)) throw new Error("Invalid framing");
  if (!Number.isInteger(c.duration) || c.duration < 15 || c.duration > 90 || typeof c.captions !== "boolean" || !Number.isInteger(c.dailyLimit) || c.dailyLimit < 1 || c.dailyLimit > 50) throw new Error("Invalid clip settings");
  const ids = new Set();
  for (const s of c.streamers) {
    if (!/^[0-9a-f-]{36}$/i.test(s.id) || ids.has(s.id) || !["armed","paused","stopped"].includes(s.status)) throw new Error("Invalid streamer");
    if (s.style !== undefined && s.style !== null && typeof s.style !== "object") throw new Error("Invalid streamer style");
    channelUrl(s.url); ids.add(s.id);
  }
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
  return { status: "error", title: null, message: typeof json?.error === "string" ? json.error.slice(0, 300) : "no readable answer from streamlink" };
}
// Armed streamers whose last live check is older than `interval`, least recently checked first.
export function dueForProbe(c, live, { running, now, interval, limit }) {
  if (c?.control !== "running") return [];
  const checked = id => live.get(id)?.checkedAt ?? 0;
  return c.streamers.filter(s => s.status === "armed" && !running.has(s.id) && now - checked(s.id) >= interval).sort((a, b) => checked(a.id) - checked(b.id)).slice(0, limit);
}
// Decides which captures to cancel and which to begin. A null config (unreachable dashboard) cancels everything.
export function plan(c, { running, blockedUntil, countToday, now, maxCaptures, isLive }) {
  const stop = [...running].filter(id => !allowed(c, id)), start = [];
  if (c?.control !== "running") return { start, stop };
  let slots = maxCaptures - (running.size - stop.length);
  for (const s of c.streamers) {
    if (slots <= 0) break;
    if (s.status !== "armed" || running.has(s.id) || !isLive(s.id) || (blockedUntil.get(s.id) ?? 0) > now || countToday(s.id) >= c.dailyLimit) continue;
    start.push(s); slots--;
  }
  return { start, stop };
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
  }
  add(id,streamer,path,duration,captions,reason=null) { this.db.prepare("INSERT INTO clips(id,streamer,path,state,created_at,duration,captions,reason) VALUES (?,?,?,'capturing',?,?,?,?)").run(id,streamer,path,new Date().toISOString(),duration,Number(captions),reason); }
  // Sentence snapping makes the final length differ slightly from the configured one.
  ready(id,sha,duration) {this.db.prepare("UPDATE clips SET state='ready',sha=?,duration=coalesce(?,duration) WHERE id=?").run(sha,duration??null,id);}
  fail(id) {this.db.prepare("UPDATE clips SET state='failed' WHERE id=?").run(id);}
  uploaded(id) {this.db.prepare("UPDATE clips SET state='uploaded' WHERE id=?").run(id);}
  rejected(id) {this.db.prepare("UPDATE clips SET state='rejected' WHERE id=?").run(id);}
  retry(id,attempt) {this.db.prepare("UPDATE clips SET attempts=?,next_try=? WHERE id=?").run(attempt,Date.now()+retryDelay(attempt),id);}
  get(id) {return this.db.prepare("SELECT * FROM clips WHERE id=?").get(id)??null;}
  pending() {return this.db.prepare("SELECT * FROM clips WHERE state='ready' AND next_try<=? ORDER BY created_at LIMIT 10").all(Date.now());}
  countToday(streamer) {return this.db.prepare("SELECT count(*) AS n FROM clips WHERE streamer=? AND created_at>=? AND state IN ('capturing','ready','uploaded')").get(streamer,new Date().toISOString().slice(0,10)).n;}
  old(before) {return this.db.prepare("SELECT * FROM clips WHERE created_at<? AND state!='capturing'").all(before);}
  remove(id) {this.db.prepare("DELETE FROM clips WHERE id=?").run(id);}
  close() {this.db.close();}
}
