// Background music, turned down or off before a clip renders (a look's audio.music, see edit.mjs): music.py splits the
// source's sound into the voice and everything else with Demucs, once per source (cached next to it), and this makes
// a copy of the source with the chosen sound: "lower" mixes the rest back in at MUSIC_LEVEL, "voice" keeps the voice
// alone. The picture is copied as it is.
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { command } from "./process.mjs";
import { hasAudio } from "./render.mjs";
import { MUSIC_LEVEL } from "./edit.mjs";

const script = fileURLToPath(new URL("./music.py", import.meta.url));
const exists = path => access(path).then(() => true, () => false);

// The ffmpeg arguments for the copy: the source's picture with the voice (and, for "lower", the rest turned down).
export function musicArgs(source, voice, rest, out, mode) {
  const sound = mode === "voice" ? ["-map", "1:a"] : ["-filter_complex", `[2:a]volume=${MUSIC_LEVEL}[r];[1:a][r]amix=inputs=2:duration=first:normalize=0[a]`, "-map", "[a]"];
  return ["-hide_banner", "-loglevel", "error", "-y", "-i", source, "-i", voice, ...(mode === "voice" ? [] : ["-i", rest]),
    "-map", "0:v", ...sound, "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart", out];
}

// The source to render from for this music mode: the source itself for "keep" (or when it has no sound), else a copy
// with the music turned down or off. Throws a readable error when Demucs isn't installed on this PC.
export async function sourceForMusic(source, mode, { python = process.env.PYTHON || "python", signal } = {}) {
  if (!mode || mode === "keep" || !await hasAudio(source, signal)) return source;
  const voice = source + ".voice.wav", rest = source + ".rest.wav", out = source + "." + mode + ".mp4";
  if (await exists(out)) return out;
  if (!await exists(voice) || !await exists(rest)) {
    try { await command(python, [script, source, voice, rest], { signal, timeout: 30 * 60_000 }).done; }
    catch (error) {
      if (/exited with code 3|Demucs isn't installed/i.test(String(error.message))) throw new Error("turning music down needs Demucs on the worker PC: py -m pip install demucs");
      throw new Error("couldn't separate the voice from the music: " + error.message);
    }
  }
  await command("ffmpeg", musicArgs(source, voice, rest, out, mode), { signal, timeout: 5 * 60_000 }).done;
  return out;
}
