// How many of the moments viewers clipped on Twitch did Clipflow also clip? A measure of what Clipflow misses.
//
//   node worker/tools/compare-viewer-clips.mjs [--since 2026-11-22T09:45]
//
// Read-only: worker/.env (credentials, never printed), the dashboard's worker config (the streamers), the worker's own
// clip history (worker/data/worker.sqlite) and Twitch's clips API (TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET). Only
// moments from when the worker was recording that streamer count: a Clipflow clip of that streamer within 20 minutes.
// Times are matched loosely: a chat or !clip window reaches 60s before and 20s after its moment, a whole-stream check
// the ~3 minutes before it was queued; a viewer clip covers the seconds before it was made.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const workerDir = fileURLToPath(new URL("..", import.meta.url));
const env = Object.fromEntries(readFileSync(workerDir + ".env", "utf8").split(/\r?\n/).map(l => l.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2].replace(/^(['"])(.*)\1$/, "$2")]));
const at = process.argv.indexOf("--since"), sinceArg = at > 0 ? Date.parse(process.argv[at + 1]) : NaN;
const { Twitch, twitchLogin } = await import(new URL("../twitch.mjs", import.meta.url));
const config = await (await fetch(env.CLIPFLOW_URL.replace(/\/$/, "") + "/api/worker/config", { headers: { authorization: "Bearer " + env.CLIPFLOW_TOKEN } })).json();
const twitch = new Twitch({ clientId: env.TWITCH_CLIENT_ID, clientSecret: env.TWITCH_CLIENT_SECRET });

const db = new DatabaseSync(workerDir + "data/worker.sqlite", { readOnly: true });
const all = db.prepare("SELECT streamer,created_at,reason,state FROM clips WHERE reason IS NULL OR reason!='viewer'").all().map(r => ({ ...r, t: Date.parse(r.created_at) }));
db.close();
const since = Number.isFinite(sinceArg) ? sinceArg : Math.min(...all.map(c => c.t)), now = Date.now();
const mine = all.filter(c => c.t >= since - 20 * 60_000);

const span = c => c.reason === "audio" ? [c.t - 185_000, c.t + 5_000] : [c.t - 85_000, c.t + 5_000];
const overlaps = (a, b) => a[0] < b[1] && b[0] < a[1];
const DAY = 86_400_000, rows = [], missed = [];
for (const s of config.streamers) {
  const login = twitchLogin(s.url);
  if (!login) continue;
  const ours = mine.filter(c => c.streamer === s.id), viewer = [];
  for (let from = since; from < now; from += DAY) {
    const list = await twitch.get("clips", { broadcaster_id: await twitch.userId(login), started_at: new Date(from).toISOString(), ended_at: new Date(Math.min(now, from + DAY)).toISOString(), first: 100 });
    for (const c of list ?? []) if (!viewer.some(v => v.id === c.id)) viewer.push(c);
  }
  let recorded = 0, caught = 0, lost = 0;
  for (const v of viewer) {
    const end = Date.parse(v.created_at), moment = [end - (v.duration ?? 30) * 1000 - 10_000, end + 10_000];
    if (end < since || !ours.some(c => Math.abs(c.t - end) < 20 * 60_000)) continue;
    recorded++;
    const near = ours.filter(c => overlaps(span(c), moment));
    if (near.some(c => c.state === "uploaded" || c.state === "ready")) caught++;
    else if (near.length) { lost++; missed.push({ login, views: v.view_count, title: v.title, at: v.created_at, why: "clipped but " + [...new Set(near.map(c => c.state))].join("/") }); }
    else missed.push({ login, views: v.view_count, title: v.title, at: v.created_at, why: "never triggered" });
  }
  rows.push({ login, viewerClips: viewer.length, whileRecording: recorded, caught, lostInProcessing: lost, missed: recorded - caught - lost });
}
const t = rows.reduce((a, r) => ({ rec: a.rec + r.whileRecording, caught: a.caught + r.caught, lost: a.lost + r.lostInProcessing }), { rec: 0, caught: 0, lost: 0 });
const pct = n => Math.round(n / Math.max(1, t.rec) * 100) + "%";
console.log("Viewer clips vs Clipflow, " + new Date(since).toISOString().slice(0, 16) + " to " + new Date(now).toISOString().slice(0, 16) + " (UTC)\n");
console.table(rows);
console.log("\nOverall: of " + t.rec + " moments viewers clipped while Clipflow was recording: " + t.caught + " caught (" + pct(t.caught) + "), " + t.lost + " clipped but lost (" + pct(t.lost) + "), " + (t.rec - t.caught - t.lost) + " never triggered (" + pct(t.rec - t.caught - t.lost) + ")");
console.log("\nMost-viewed misses:");
for (const m of missed.sort((a, b) => b.views - a.views).slice(0, 15)) console.log(String(m.views).padStart(6), "views |", m.login.padEnd(12), "|", m.at.slice(5, 16), "|", m.why.padEnd(28), "|", String(m.title).slice(0, 60));
