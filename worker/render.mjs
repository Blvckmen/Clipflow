// Renders a clip from its source and an edit (see edit.mjs). Used for every clip: the first automatic render after
// capture and each re-render requested from the dashboard editor.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, dirname, join } from "node:path";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { command } from "./process.mjs";
import { clipHash } from "./core.mjs";
import { buildAss, filterGraph, needsSubtitles, timeline } from "./edit.mjs";
import { sourceForMusic } from "./music.mjs";
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

// A stream filmed on a phone (Twitch and Kick IRL streams): an upright picture with black bars either side of the
// landscape stream. Finds that picture with ffmpeg's cropdetect over four seconds from the middle of the source (the
// largest picture seen, so a dark moment doesn't shrink it). Returns its rectangle as fractions of the frame, or null
// when the stream isn't like that (see phonePicture).
export async function findPhonePicture(file, { width, height, duration }, signal) {
  if (!(width > height)) return null;
  try {
    const at = Math.max(0, Math.min((duration || 0) - 4, (duration || 0) / 2 - 2));
    const { stderr } = await run("ffmpeg", ["-hide_banner", "-ss", String(at), "-i", file, "-t", "4", "-an", "-sn", "-vf", "fps=2,cropdetect=limit=24:round=2:reset=0", "-f", "null", "-"], { signal, timeout: 60_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    const last = [...stderr.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)].at(-1);
    if (!last) return null;
    const [w, h, x, y] = last.slice(1, 5).map(Number);
    return phonePicture({ x, y, w, h }, width, height);
  } catch { return null; }
}
// The decision, on cropdetect's rectangle (pixels): a phone picture is upright (taller than wide) and leaves bars of
// at least a tenth of the width beside it; anything else (a normal landscape stream, a letterboxed film) is null.
export function phonePicture({ x, y, w, h }, width, height) {
  if (!(width > 0 && height > 0 && w > 0 && h > 0) || w > width * 0.8 || h < w * 1.05 || h < height * 0.6) return null;
  const r = n => Math.round(n * 10000) / 10000;
  return { x: r(x / width), y: r(y / height), w: r(Math.min(w, width - x) / width), h: r(Math.min(h, height - y) / height) };
}

// Whether a media file has a sound track.
export async function hasAudio(file, signal) {
  try {
    const { stdout } = await run("ffprobe", ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", file], { signal, timeout: 30_000, windowsHide: true });
    return stdout.trim().length > 0;
  } catch { return false; }
}

// Writes the rendered clip to `out`. Returns { sha, size, duration } (duration after any jump cuts). `background`
// ({ path, start }) is the split-screen video, looped from `start` seconds; without it split screen renders as the
// blurred fill. `energy` is the source's per-second loudness (the clip's signals), for jump cuts and punch-ins.
// `messages` is the clip's Twitch chat (signals.messages), shown when the look has chat on.
export async function renderClip(source, { edit, words, width, height, background = null, energy = null, messages = [] }, out, signal) {
  // Background music turned down or off (the look's audio.music): render from a copy of the source with that sound.
  source = await sourceForMusic(source, edit.audio?.music, { signal });
  const dir = dirname(out), ass = basename(out).replace(/\.mp4$/, "") + ".ass";
  const tl = timeline(edit, words, energy);
  const subtitles = needsSubtitles(edit, words, messages) ? ass : null;
  if (subtitles) await writeFile(join(dir, ass), buildAss(edit, words, tl, messages), "utf8");
  const length = edit.trim.end - edit.trim.start, split = edit.frame.mode === "split" && !!background;
  // The background video's sound, when it is turned up and the video has some; the stream's, when cuts are taken
  // out of it.
  const mixing = split && !background.image && (edit.frame.split?.volume ?? 0) > 0;
  const audio = mixing || tl.cuts.length ? { source: await hasAudio(source, signal), background: mixing && await hasAudio(background.path, signal) } : null;
  const graph = filterGraph(edit, { width, height }, subtitles, { background: split, audio, tl });
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
  return { sha: clipHash(await readFile(out)), size, duration: Math.round(tl.length) };
}
