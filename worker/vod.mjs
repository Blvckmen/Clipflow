// Downloading past streams and videos imported from a link (see video-link.mjs for which links).
import { execFile } from "node:child_process";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { command } from "./process.mjs";
export { PLATFORM_NAMES, videoLink } from "./video-link.mjs";
const run = promisify(execFile);

// How to run yt-dlp on this PC ({ binary, prefix }), or null when it isn't installed. YTDLP may name the program.
let found;
export function findYtDlp(env = process.env, python = env.PYTHON || "python") {
  found ??= (async () => {
    for (const [binary, prefix] of [[env.YTDLP || "yt-dlp", []], [python, ["-m", "yt_dlp"]]]) {
      try { await run(binary, [...prefix, "--version"], { timeout: 30_000, windowsHide: true }); return { binary, prefix }; } catch { /* try the next */ }
    }
    return null;
  })();
  return found;
}

// H.264 and AAC at up to 720p where the site offers them: clips are cut from the file without re-encoding.
const FORMAT = "bv*[height<=720][vcodec^=avc1]+ba[acodec^=mp4a]/b[height<=720][vcodec^=avc1]/bv*[height<=720]+ba/b[height<=720]/b";
const QUALITY = "720p,720p60,480p,best";

// The downloader for a link: yt-dlp when installed (it is the only option for YouTube), else streamlink.
export function downloadPlan(link, dir, { ytdlp, streamlink = "streamlink" }) {
  if (ytdlp) return { binary: ytdlp.binary, args: [...ytdlp.prefix, "--no-playlist", "--no-progress", "--newline", "-f", FORMAT, "--merge-output-format", "mp4", "-o", join(dir, "download.%(ext)s"), "--", link.url] };
  if (link.platform === "youtube") return null;
  return { binary: streamlink, args: ["--http-timeout", "20", "--stream-segment-threads", "3", "--force", "-o", join(dir, "download.ts"), link.url, QUALITY] };
}

// The video's title (or null), without downloading it.
export async function videoTitle(link, { ytdlp, streamlink = "streamlink", signal }) {
  try {
    if (ytdlp) {
      const { stdout } = await run(ytdlp.binary, [...ytdlp.prefix, "--no-playlist", "--skip-download", "--print", "title", "--", link.url], { timeout: 60_000, windowsHide: true, signal, maxBuffer: 1 << 20 });
      return stdout.trim().split(/\r?\n/)[0]?.slice(0, 200) || null;
    }
    const { stdout } = await run(streamlink, ["--json", "--http-timeout", "20", link.url], { timeout: 60_000, windowsHide: true, signal, maxBuffer: 4 << 20 });
    const title = JSON.parse(stdout)?.metadata?.title;
    return typeof title === "string" && title.trim() ? title.trim().slice(0, 200) : null;
  } catch { return null; }
}

// The codecs of a file's first video and audio streams.
async function codecs(file, signal) {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name", "-of", "json", file], { timeout: 60_000, windowsHide: true, signal, maxBuffer: 1 << 20 });
  const streams = JSON.parse(stdout).streams ?? [];
  return { video: streams.find(s => s.codec_type === "video")?.codec_name ?? null, audio: streams.find(s => s.codec_type === "audio")?.codec_name ?? null };
}

// Turns a download into the recording's MP4: copied when it is already H.264/AAC (recordings are cut by copying
// into MPEG-TS), else re-encoded once.
export async function toRecording(input, out, { signal, seconds = 3600 } = {}) {
  const { video, audio } = await codecs(input, signal);
  if (!video) throw new Error("the download has no video");
  const copy = video === "h264" && (!audio || audio === "aac");
  const codec = copy ? ["-c", "copy"] : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-vf", "scale=-2:'min(720,ih)'", "-c:a", "aac", "-b:a", "160k"];
  await command("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", input, "-map", "0:v:0", "-map", "0:a:0?", ...codec, ...(copy && audio ? ["-bsf:a", "aac_adtstoasc"] : []), "-movflags", "+faststart", out],
    { signal, timeout: copy ? 60 * 60_000 : Math.max(60 * 60_000, Math.ceil(seconds) * 2000) }).done;
  return copy;
}

// Downloads a link into `dir` and saves it as `out`. Throws with a readable reason.
export async function downloadVideo(link, dir, out, { ytdlp, streamlink, signal, timeout = 8 * 3600_000 }) {
  const plan = downloadPlan(link, dir, { ytdlp, streamlink });
  if (!plan) throw new Error("YouTube videos need yt-dlp on the worker PC (run: py -m pip install yt-dlp), then try again");
  await command(plan.binary, plan.args, { signal, timeout }).done;
  const file = (await readdir(dir)).find(f => /^download\.(mp4|ts|mkv|webm)$/.test(f));
  if (!file) throw new Error("the download finished without a video file");
  await toRecording(join(dir, file), out, { signal });
  await rm(join(dir, file), { force: true });
}
