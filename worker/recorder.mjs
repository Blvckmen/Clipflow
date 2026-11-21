import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { command, lastLines, tail } from "./process.mjs";

const SEGMENT = /^seg\d{6}\.m2t$/;
const MAX_RESUMES = 3, RESUME_WINDOW_MS = 10 * 60_000;

// The first leg's segment list is list.csv (as before resuming existed); later legs get list-001.csv and so on.
export function listName(leg) { return leg ? "list-" + String(leg).padStart(3, "0") + ".csv" : "list.csv"; }

// Records a live channel continuously into short MPEG-TS segments and keeps only the last `bufferSeconds`.
// Media files use .m2t rather than .ts so TypeScript tooling never mistakes them for source.
// Each segment's wall-clock span is taken from when ffmpeg finished it (live input, so ~real time).
// With `keep`, nothing is pruned and the segments stay on disk after stop(): the whole stream is kept, and
// recordings.mjs joins it into one file (list.csv gives the segment order).
export class Recorder {
  constructor(url, dir, { bufferSeconds = 240, segmentSeconds = 6, streamlink = "streamlink", quality = "720p,720p60,480p,best", keep = false } = {}) {
    Object.assign(this, { url, dir, bufferMs: bufferSeconds * 1000, segmentSeconds, streamlink, quality, keep });
    this.segments = [];  // { file, startMs, endMs }
    this.gaps = [];      // { fromMs, toMs } wall-clock spans lost between a failed leg and the next one
    this.pinned = new Set();
    this.listed = 0;
    this.ended = false;
    this.error = null;  // set when recording stopped for a reason other than the stream ending
  }

  async start() {
    await rm(this.dir, { recursive: true, force: true });
    await mkdir(this.dir, { recursive: true });
    this.leg = -1;
    this.nextNumber = 0;  // first segment number for the next leg, so legs never overwrite each other's files
    this.resumes = [];    // when each resume happened
    this.exited = new Promise(resolve => { this.resolveExited = resolve; });
    this.launch();
    this.timer = setInterval(() => void this.poll(), 1000);
  }

  // One leg: a streamlink -> ffmpeg pipeline. When a leg fails mid-stream (e.g. ffmpeg rejecting a malformed FLV
  // packet), the next leg picks up in the same directory with its own segment list, so the recording continues
  // with a few seconds missing instead of being split in two.
  launch() {
    this.leg += 1;
    this.list = listName(this.leg);
    this.listed = 0;
    this.legSegments = 0;
    const source = this.source = spawn(this.streamlink, ["--loglevel", "error", "--http-timeout", "15", "--stream-timeout", "25", "--stdout", this.url, this.quality], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const ffmpeg = this.ffmpeg = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", "pipe:0", "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy",
      "-f", "segment", "-segment_time", String(this.segmentSeconds), "-reset_timestamps", "1", "-segment_format", "mpegts", "-segment_start_number", String(this.nextNumber),
      "-segment_list", this.list, "-segment_list_type", "csv", "-segment_list_flags", "+live", "seg%06d.m2t"], { cwd: this.dir, stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
    source.stdout.on("error", () => {}); ffmpeg.stdin.on("error", () => {});
    source.stdout.pipe(ffmpeg.stdin);
    const sourceLog = tail(source.stderr), ffmpegLog = tail(ffmpeg.stderr);
    let sourceExit = null, startError = null, done = false;
    source.once("exit", code => { sourceExit = code; });
    const end = async () => {
      if (done) return;
      done = true;
      // A stream going offline is a normal ending; anything else is a problem worth showing.
      const said = lastLines(sourceLog.text, 1);
      let error = null;
      if (startError) error = startError;
      else if (!this.stopping && !/no playable streams|stream ended|offline/i.test(said) && (said || sourceExit || lastLines(ffmpegLog.text)))
        error = said ? "streamlink: " + said : "recording stopped: " + (lastLines(ffmpegLog.text) || "ffmpeg exited");
      if (error && !startError && !this.stopping) {
        source.kill();
        await this.flush();
        if (!this.stopping && this.mayResume()) {
          console.warn("Recording " + this.url + " hit a problem, resuming: " + error);
          this.resumes.push(Date.now());
          this.nextNumber = await this.highestNumber() + 1;
          if (!this.stopping) return this.launch();
        }
      }
      this.error = this.stopping ? null : error;
      this.ended = true;
      this.resolveExited();
    };
    ffmpeg.once("close", () => void end());
    ffmpeg.once("error", error => { startError = "ffmpeg could not start (" + (error.code ?? error.message) + ")"; void end(); });
    source.once("error", error => { startError = "streamlink could not start (" + (error.code ?? error.message) + ")"; ffmpeg.kill(); void end(); });
  }

  // Resume only after a leg that recorded something (a leg failing straight away would fail again), and at most
  // MAX_RESUMES times in RESUME_WINDOW_MS, so a stream that keeps breaking still ends up reported.
  mayResume() {
    const now = Date.now();
    this.resumes = this.resumes.filter(t => t > now - RESUME_WINDOW_MS);
    return this.legSegments > 0 && this.resumes.length < MAX_RESUMES;
  }

  async highestNumber() {
    const names = (await readdir(this.dir).catch(() => [])).filter(f => SEGMENT.test(f));
    return Math.max(this.nextNumber - 1, ...names.map(f => Number(f.slice(3, 9))), ...this.segments.map(s => Number(s.file.slice(3, 9))));
  }

  // Reads the current list after any read already in progress, so nothing the leg wrote is missed.
  async flush() { await this.poll(); await this.poll(); }

  poll() {
    this.polling ??= this.read().finally(() => { this.polling = null; });
    return this.polling;
  }

  async read() {
    const leg = this.leg;
    const rows = (await readFile(join(this.dir, this.list), "utf8").catch(() => "")).split(/\r?\n/).filter(Boolean);
    if (leg !== this.leg) return;  // a new leg started while reading; its own list is read next time
    const now = Date.now();
    for (const row of rows.slice(this.listed)) {
      const [file, start, end] = row.split(",");
      const seconds = Number(end) - Number(start);
      if (!SEGMENT.test(file) || !(seconds > 0)) continue;
      const segment = { file, startMs: now - seconds * 1000, endMs: now }, previous = this.segments.at(-1);
      // The first segment after a resume: the time since the last one is missing from the footage.
      if (this.legSegments === 0 && this.leg > 0 && previous && segment.startMs > previous.endMs) this.gaps.push({ fromMs: previous.endMs, toMs: segment.startMs });
      this.segments.push(segment);
      this.legSegments += 1;
    }
    this.listed = rows.length;
    while (!this.keep && this.segments.length && this.segments[0].endMs < now - this.bufferMs && !this.pinned.has(this.segments[0].file))
      await rm(join(this.dir, this.segments.shift().file), { force: true });
  }

  // Maps a wall-clock time to the same moment on the recorded footage's clock, which runs behind by the gaps left
  // by resumes. Returns null for a time inside a gap (nothing was recorded then).
  footageMs(wallMs) {
    let missing = 0;
    for (const gap of this.gaps) {
      if (wallMs >= gap.toMs) missing += gap.toMs - gap.fromMs;
      else if (wallMs > gap.fromMs) return null;
    }
    return wallMs - missing;
  }

  // Seconds of media currently held.
  buffered() { return this.segments.length ? (this.segments.at(-1).endMs - this.segments[0].startMs) / 1000 : 0; }
  latestMs() { return this.segments.at(-1)?.endMs ?? 0; }

  // Joins the segments overlapping [fromMs, toMs] into one file; returns the wall-clock time where it begins.
  async extract(fromMs, toMs, out, signal) {
    const parts = this.segments.filter(s => s.endMs > fromMs && s.startMs < toMs);
    if (!parts.length) throw new Error("Nothing buffered for that time range");
    for (const p of parts) this.pinned.add(p.file);
    try {
      await writeFile(join(this.dir, "concat.txt"), parts.map(p => "file '" + p.file + "'").join("\n"));
      await command("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", "concat.txt", "-c", "copy", "-f", "mpegts", out], { cwd: this.dir, signal, timeout: 60_000 }).done;
      return parts[0].startMs;
    } finally { for (const p of parts) this.pinned.delete(p.file); }
  }

  async stop() {
    this.stopping = true;
    clearInterval(this.timer);
    this.source?.kill("SIGTERM"); this.ffmpeg?.kill("SIGTERM");
    const force = setTimeout(() => { this.source?.kill("SIGKILL"); this.ffmpeg?.kill("SIGKILL"); }, 3000);
    await Promise.race([this.exited, new Promise(resolve => setTimeout(resolve, 5000))]);
    clearTimeout(force);
    if (!this.keep) await rm(this.dir, { recursive: true, force: true }).catch(() => {});
  }
}
