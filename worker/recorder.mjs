import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { command, lastLines, tail } from "./process.mjs";

// Records a live channel continuously into short MPEG-TS segments and keeps only the last `bufferSeconds`.
// Media files use .m2t rather than .ts so TypeScript tooling never mistakes them for source.
// Each segment's wall-clock span is taken from when ffmpeg finished it (live input, so ~real time).
// With `keep`, nothing is pruned and the segments stay on disk after stop(): the whole stream is kept, and
// recordings.mjs joins it into one file (list.csv gives the segment order).
export class Recorder {
  constructor(url, dir, { bufferSeconds = 240, segmentSeconds = 6, streamlink = "streamlink", quality = "720p,720p60,480p,best", keep = false } = {}) {
    Object.assign(this, { url, dir, bufferMs: bufferSeconds * 1000, segmentSeconds, streamlink, quality, keep });
    this.segments = [];  // { file, startMs, endMs }
    this.pinned = new Set();
    this.listed = 0;
    this.ended = false;
    this.error = null;  // set when recording stopped for a reason other than the stream ending
  }

  async start() {
    await rm(this.dir, { recursive: true, force: true });
    await mkdir(this.dir, { recursive: true });
    this.source = spawn(this.streamlink, ["--loglevel", "error", "--http-timeout", "15", "--stream-timeout", "25", "--stdout", this.url, this.quality], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    this.ffmpeg = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", "pipe:0", "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy",
      "-f", "segment", "-segment_time", String(this.segmentSeconds), "-reset_timestamps", "1", "-segment_format", "mpegts",
      "-segment_list", "list.csv", "-segment_list_type", "csv", "-segment_list_flags", "+live", "seg%06d.m2t"], { cwd: this.dir, stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
    this.source.stdout.on("error", () => {}); this.ffmpeg.stdin.on("error", () => {});
    this.source.stdout.pipe(this.ffmpeg.stdin);
    const sourceLog = tail(this.source.stderr), ffmpegLog = tail(this.ffmpeg.stderr);
    let sourceExit = null, startError = null;
    this.source.once("exit", code => { sourceExit = code; });
    this.exited = new Promise(resolve => {
      const end = () => {
        if (this.ended) return;
        this.ended = true;
        // A stream going offline is a normal ending; anything else is a problem worth showing.
        const said = lastLines(sourceLog.text, 1);
        if (startError) this.error = startError;
        else if (!this.stopping && !/no playable streams|stream ended|offline/i.test(said) && (said || sourceExit || lastLines(ffmpegLog.text)))
          this.error = said ? "streamlink: " + said : "recording stopped: " + (lastLines(ffmpegLog.text) || "ffmpeg exited");
        resolve();
      };
      this.ffmpeg.once("close", end);
      this.ffmpeg.once("error", error => { startError = "ffmpeg could not start (" + (error.code ?? error.message) + ")"; end(); });
      this.source.once("error", error => { startError = "streamlink could not start (" + (error.code ?? error.message) + ")"; this.ffmpeg.kill(); end(); });
    });
    this.timer = setInterval(() => void this.poll(), 1000);
  }

  async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      const rows = (await readFile(join(this.dir, "list.csv"), "utf8").catch(() => "")).split(/\r?\n/).filter(Boolean);
      const now = Date.now();
      for (const row of rows.slice(this.listed)) {
        const [file, start, end] = row.split(",");
        const seconds = Number(end) - Number(start);
        if (/^seg\d{6}\.m2t$/.test(file) && seconds > 0) this.segments.push({ file, startMs: now - seconds * 1000, endMs: now });
      }
      this.listed = rows.length;
      while (!this.keep && this.segments.length && this.segments[0].endMs < now - this.bufferMs && !this.pinned.has(this.segments[0].file))
        await rm(join(this.dir, this.segments.shift().file), { force: true });
    } finally { this.polling = false; }
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
