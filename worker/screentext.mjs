// Game banners on screen (WASTED, MISSION PASSED, VICTORY ROYALE...), read by screentext.py with RapidOCR.
import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { command } from "./process.mjs";
const run = promisify(execFile);
const script = fileURLToPath(new URL("./screentext.py", import.meta.url));

// Whether this PC can read the screen (RapidOCR installed for `python`); checked once.
let ready;
export function screenTextAvailable(python) {
  ready ??= run(python, ["-c", "import rapidocr_onnxruntime, yaml, numpy"], { timeout: 60_000, windowsHide: true }).then(() => true, () => false);
  return ready;
}

// [{ t, text }] for the banners in `file`, reading one frame every `every` seconds inside `ranges` ([[from, to]]).
export async function screenText(file, { python, ranges, every = 2, signal, scratch }) {
  const out = scratch + ".json", list = scratch + "-ranges.json";
  const seconds = ranges.reduce((t, [a, b]) => t + (b - a), 0);
  try {
    await writeFile(list, JSON.stringify(ranges));
    // About 2s of CPU a frame on a busy PC, so the timeout follows the frame count.
    await command(python, [script, file, out, String(every), list], { signal, timeout: Math.max(10 * 60_000, (seconds / every) * 6000) }).done;
    const { events } = JSON.parse(await readFile(out, "utf8"));
    return Array.isArray(events) ? events.filter(e => Number.isFinite(e?.t) && typeof e.text === "string") : [];
  } finally {
    await rm(out, { force: true }); await rm(list, { force: true });
  }
}
