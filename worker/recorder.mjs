import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { command } from "./process.mjs";

// Records a live channel continuously into short MPEG-TS segments and keeps only the last `bufferSeconds`.
// Each segment's wall-clock span is taken from when ffmpeg finished it (live input, so ~real time).
export class Recorder {
  constructor(url, dir, { bufferSeconds = 240, segmentSeconds = 6, streamlink = "streamlink", quality = "720p,720p60,480p,best" } = {}) {
    Object.assign(this, { url, dir, bufferMs: bufferSeconds * 1000, segmentSeconds, streamlink, quality });
    this.segments = [];  // { file, startMs, endMs }
    this.pinned = new Set();
    this.listed = 0;
    this.ended = false;
  }

  async start() {
    await rm(this.dir, { recursive: true, force: true });
    await mkdir(this.dir, { recursive: true });
    this.source = spawn(this.streamlink, ["--loglevel", "error", "--http-timeout", "15", "--stream-timeout", "25", "--stdout", this.url, this.quality], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    this.ffmpeg = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", "pipe:0", "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy",
      "-f", "segment", "-segment_time", String(this.segmentSeconds), "-reset_timestamps", "1", "-segment_format", "mpegts",
      "-segment_list", "list.csv", "-segment_list_type", "csv", "-segment_list_flags", "+live", "seg%06d.ts"], { cwd: this.dir, stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
    this.source.stdout.on("error", () => {}); this.ffmpeg.stdin.on("error", () => {});
    this.source.stdout.pipe(this.ffmpeg.stdin);
    this.exited = new Promise(resolve => {
      const end = () => { this.ended = true; resolve(); };
      this.ffmpeg.once("exit", end); this.ffmpeg.once("error", end); this.source.once("error", end);
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
        if (/^seg\d{6}\.ts$/.test(file) && seconds > 0) this.segments.push({ file, startMs: now - seconds * 1000, endMs: now });
      }
      this.listed = rows.length;
      while (this.segments.length && this.segments[0].endMs < now - this.bufferMs && !this.pinned.has(this.segments[0].file))
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
      await command("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", "concat.txt", "-c", "copy", out], { cwd: this.dir, signal, timeout: 60_000 }).done;
      return parts[0].startMs;
    } finally { for (const p of parts) this.pinned.delete(p.file); }
  }

  async stop() {
    clearInterval(this.timer);
    this.source?.kill("SIGTERM"); this.ffmpeg?.kill("SIGTERM");
    const force = setTimeout(() => { this.source?.kill("SIGKILL"); this.ffmpeg?.kill("SIGKILL"); }, 3000);
    await Promise.race([this.exited, new Promise(resolve => setTimeout(resolve, 5000))]);
    clearTimeout(force);
    await rm(this.dir, { recursive: true, force: true }).catch(() => {});
  }
}
