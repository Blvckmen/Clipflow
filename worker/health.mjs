// Health facts about this PC for the dashboard's Settings → This PC (lib/pc-health.mjs turns them into problems and
// fixes, so the wording can change without restarting the worker). Only facts here: free disk space, whether each
// tool runs, whether the Whisper model is downloaded, whether Ollama answers and has its models, and whether the
// worker's own files changed on disk since it started (updated code waiting for a restart).
import { execFile } from "node:child_process";
import { readdir, stat, statfs } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const here = fileURLToPath(new URL(".", import.meta.url));
const GB = 2 ** 30;

// Runs a command and says whether it exited cleanly within `timeout`.
export function runs(cmd, args, timeout = 20_000) {
  return new Promise(resolve => {
    try { execFile(cmd, args, { timeout, windowsHide: true }, error => resolve(!error)); } catch { resolve(false); }
  });
}

// The newest modification time of the worker's own code (.mjs and .py next to this file), in ms.
export async function codeStamp(dir = here) {
  let newest = 0;
  for (const name of await readdir(dir).catch(() => [])) {
    if (!/\.(mjs|py)$/.test(name)) continue;
    const s = await stat(join(dir, name)).catch(() => null);
    if (s && s.mtimeMs > newest) newest = s.mtimeMs;
  }
  return newest;
}

// faster-whisper keeps a downloaded model in <root>/models--Systran--faster-whisper-<name>. null: a model name this
// can't check (a path, or a model from elsewhere).
export async function whisperModelReady(root, name) {
  if (!/^(tiny|base|small|medium|large-v[123]|large)(\.en)?$/.test(name)) return null;
  const s = await stat(join(root, "models--Systran--faster-whisper-" + name)).catch(() => null);
  return !!s?.isDirectory();
}

// Ollama: "off" (the writer is turned off), "down" (no answer), or "ok" with the wanted models it doesn't have.
export async function ollamaState(url, models, enabled, fetchImpl = fetch) {
  if (!enabled) return { state: "off", missing: [] };
  try {
    const r = await fetchImpl(url.replace(/\/$/, "") + "/api/tags", { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return { state: "down", missing: [] };
    const have = new Set(((await r.json())?.models ?? []).flatMap(m => [m.name, m.model]).filter(Boolean));
    // "qwen2.5:7b" is listed as is; a model asked for without a tag is listed as "<name>:latest".
    const missing = [...new Set(models)].filter(m => !have.has(m) && !have.has(m + ":latest"));
    return { state: "ok", missing };
  } catch { return { state: "down", missing: [] }; }
}

/**
 * All the facts at once (takes a few seconds: it starts ffmpeg, streamlink and Python).
 * @returns {Promise<{ checkedAt: string, diskFreeGb: number | null, diskTotalGb: number | null, ffmpeg: boolean,
 *   streamlink: boolean, whisper: boolean, whisperModel: string, whisperReady: boolean | null, ollama: string,
 *   ollamaMissing: string[], codeChanged: boolean }>}
 */
export async function checkHealth({ dataDir, whisperDir, whisperModel, python, streamlink, ollamaUrl, ollamaModels, aiWriter, startedStamp }) {
  const disk = await statfs(dataDir).catch(() => null);
  const [ffmpeg, streamlinkOk, whisper, whisperReady, ollama, stamp] = await Promise.all([
    runs("ffmpeg", ["-version"]),
    runs(streamlink, ["--version"]),
    runs(python, ["-c", "import faster_whisper"], 60_000),
    whisperModelReady(whisperDir, whisperModel),
    ollamaState(ollamaUrl, ollamaModels, aiWriter),
    codeStamp(),
  ]);
  return {
    checkedAt: new Date().toISOString(),
    diskFreeGb: disk ? Math.round(disk.bavail * disk.bsize / GB * 10) / 10 : null,
    diskTotalGb: disk ? Math.round(disk.blocks * disk.bsize / GB * 10) / 10 : null,
    ffmpeg, streamlink: streamlinkOk, whisper, whisperModel, whisperReady,
    ollama: ollama.state, ollamaMissing: ollama.missing.slice(0, 5),
    codeChanged: stamp > startedStamp + 1000,
  };
}
