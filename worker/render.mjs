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

export async function videoInfo(file, signal) {
  try {
    const { stdout } = await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "json", file], { signal, timeout: 30_000, windowsHide: true });
    const json = JSON.parse(stdout);
    return { width: json.streams?.[0]?.width ?? 0, height: json.streams?.[0]?.height ?? 0, duration: Number(json.format?.duration) || 0 };
  } catch { return { width: 0, height: 0, duration: 0 }; }
}

// Writes the rendered clip to `out`. Returns { sha, size, duration }.
export async function renderClip(source, { edit, words, width, height }, out, signal) {
  const dir = dirname(out), ass = basename(out).replace(/\.mp4$/, "") + ".ass";
  const subtitles = needsSubtitles(edit, words) ? ass : null;
  if (subtitles) await writeFile(join(dir, ass), buildAss(edit, words), "utf8");
  const length = edit.trim.end - edit.trim.start;
  try {
    await command("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(edit.trim.start), "-t", String(length), "-i", source,
      "-filter_complex", filterGraph(edit, { width, height }, subtitles), "-map", "[vout]", "-map", "0:a?",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-maxrate", "2500k", "-bufsize", "5000k", "-r", "30",
      "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", basename(out)], { signal, cwd: dir }).done;
  } finally { if (subtitles) await rm(join(dir, ass), { force: true }); }
  const size = (await stat(out)).size;
  if (size < 1024 || size > MAX_CLIP_BYTES) throw new Error("Rendered clip size outside allowed range (" + size + " bytes)");
  return { sha: clipHash(await readFile(out)), size, duration: Math.round(length) };
}
