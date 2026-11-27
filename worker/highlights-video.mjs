// Highlight videos: several clips' moments, cut from their unframed sources and joined into one landscape (16:9)
// video for YouTube. Each piece is scaled to fit 1280x720 over a blurred copy of itself (so phone streams and odd
// sizes fill the frame), with short fades so cuts don't jar, and silent audio where a source has none.
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { command } from "./process.mjs";
import { hasAudio, videoInfo } from "./render.mjs";

export const HL_W = 1280, HL_H = 720, HL_FADE = 0.4;

// The ffmpeg arguments for one piece: [start, end] of `source` (seconds), as 1280x720 30 fps H.264 + 48 kHz AAC.
export function pieceArgs(source, out, { start, end, audio }) {
  const length = Math.max(1, end - start), fadeOut = Math.max(0, length - HL_FADE);
  const video = `[0:v]split=2[bg][fg];[bg]scale=${HL_W}:${HL_H}:force_original_aspect_ratio=increase,crop=${HL_W}:${HL_H},boxblur=20:2,eq=brightness=-0.08[b];`
    + `[fg]scale=${HL_W}:${HL_H}:force_original_aspect_ratio=decrease[f];[b][f]overlay=(W-w)/2:(H-h)/2,fps=30,format=yuv420p,`
    + `fade=t=in:st=0:d=${HL_FADE},fade=t=out:st=${fadeOut.toFixed(2)}:d=${HL_FADE}[v]`;
  const sound = (audio ? "[0:a]" : "[1:a]") + `aresample=48000,afade=t=in:st=0:d=${HL_FADE},afade=t=out:st=${fadeOut.toFixed(2)}:d=${HL_FADE}[a]`;
  return ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(start), "-t", String(length), "-i", source,
    ...(audio ? [] : ["-f", "lavfi", "-t", String(length), "-i", "anullsrc=r=48000:cl=stereo"]),
    "-filter_complex", video + ";" + sound, "-map", "[v]", "-map", "[a]",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-maxrate", "3500k", "-bufsize", "7000k", "-g", "60",
    "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", out];
}

// Makes the video: `pieces` are { source, start, end } in order. Returns { duration } of the result at `out`.
export async function makeHighlightVideo(pieces, out, { dir, signal }) {
  if (!pieces.length) throw new Error("no clips to join");
  const files = [];
  for (const [i, p] of pieces.entries()) {
    const file = join(dir, "piece-" + i + ".mp4");
    const length = Math.max(1, p.end - p.start);
    await command("ffmpeg", pieceArgs(p.source, file, { start: p.start, end: p.end, audio: await hasAudio(p.source, signal) }), { signal, timeout: Math.max(120_000, length * 8_000) }).done;
    files.push(file);
  }
  // Same codecs and sizes throughout, so the pieces join without another encode.
  const list = join(dir, "pieces.txt");
  await writeFile(list, files.map(f => "file '" + f.replace(/\\/g, "/").replace(/'/g, "'\\''") + "'").join("\n"));
  await command("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", out], { signal, timeout: 600_000 }).done;
  const info = await videoInfo(out, signal);
  return { duration: info.duration };
}
