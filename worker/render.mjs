// Renders a clip from its source and an edit (see edit.mjs). Used for every clip: the first automatic render after
// capture and each re-render requested from the dashboard editor.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, dirname, join } from "node:path";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { command } from "./process.mjs";
import { clipHash } from "./core.mjs";
import { buildAss, filterGraph, needsSubtitles } from "./edit.mjs";
const run = promisify(execFile);

export const MAX_CLIP_BYTES = 32 * 1024 * 1024;
// How long an encode of `seconds` of video may take. A busy older laptop encodes 720p at about a third of real
// time, so a fixed limit cuts long clips off; allow 20s per second of video, and never less than 5 minutes.
export const encodeTimeout = seconds => Math.max(300_000, Math.ceil(seconds) * 20_000);

export async function videoInfo(file, signal) {
  try {
    const { stdout } = await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "json", file], { signal, timeout: 30_000, windowsHide: true });
    const json = JSON.parse(stdout);
    return { width: json.streams?.[0]?.width ?? 0, height: json.streams?.[0]?.height ?? 0, duration: Number(json.format?.duration) || 0 };
  } catch { return { width: 0, height: 0, duration: 0 }; }
}

// Whether a media file has a sound track.
export async function hasAudio(file, signal) {
  try {
    const { stdout } = await run("ffprobe", ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", file], { signal, timeout: 30_000, windowsHide: true });
    return stdout.trim().length > 0;
  } catch { return false; }
}

// Writes the rendered clip to `out`. Returns { sha, size, duration }. `background` ({ path, start }) is the
// split-screen video, looped from `start` seconds; without it split screen renders as the blurred fill.
export async function renderClip(source, { edit, words, width, height, background = null }, out, signal) {
  const dir = dirname(out), ass = basename(out).replace(/\.mp4$/, "") + ".ass";
  const subtitles = needsSubtitles(edit, words) ? ass : null;
  if (subtitles) await writeFile(join(dir, ass), buildAss(edit, words), "utf8");
  const length = edit.trim.end - edit.trim.start, split = edit.frame.mode === "split" && !!background;
  // The background video's sound, when it is turned up and the video has some.
  const mixing = split && !background.image && (edit.frame.split?.volume ?? 0) > 0;
  const audio = mixing ? { source: await hasAudio(source, signal), background: await hasAudio(background.path, signal) } : null;
  const graph = filterGraph(edit, { width, height }, subtitles, { background: split, audio });
  try {
    await command("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(edit.trim.start), "-t", String(length), "-i", source,
      // A video background loops from its start point; an image is repeated as a 30 fps stream.
      ...(split ? (background.image ? ["-loop", "1", "-framerate", "30", "-i", background.path] : ["-stream_loop", "-1", "-ss", String(background.start ?? 0), "-i", background.path]) : []),
      "-filter_complex", graph, "-map", "[vout]", ...(graph.includes("[aout]") ? ["-map", "[aout]"] : ["-map", "0:a?"]),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-maxrate", "2500k", "-bufsize", "5000k", "-r", "30",
      "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", basename(out)], { signal, cwd: dir, timeout: encodeTimeout(length) }).done;
  } finally { if (subtitles) await rm(join(dir, ass), { force: true }); }
  const size = (await stat(out)).size;
  if (size < 1024 || size > MAX_CLIP_BYTES) throw new Error("Rendered clip size outside allowed range (" + size + " bytes)");
  return { sha: clipHash(await readFile(out)), size, duration: Math.round(length) };
}
