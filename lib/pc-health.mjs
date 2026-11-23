// Turns the health facts the worker reports (worker/health.mjs, sent with its status as device.health) into problems
// for Settings → This PC: what's wrong in plain words and how to fix it, worst first. Pure, so the wording can change
// here without restarting the worker, and it can be tested on its own.

const MODEL_SIZE = { tiny: "75 MB", base: "150 MB", small: "500 MB", medium: "1.5 GB", "large-v3": "3 GB" };
const STALE_MS = 30 * 60_000;

/**
 * @param {object | null | undefined} device what the worker last reported (app/api/worker/status `device`)
 * @param {{ now?: number, connected?: boolean }} [o]
 * @returns {{ id: string, level: "bad" | "warn" | "info", title: string, fix: string, action?: "restart" }[]}
 */
export function pcProblems(device, { now = Date.now(), connected = true } = {}) {
  const out = [];
  const h = device?.health;
  // Facts from a PC that's offline or hasn't checked for a while say little about now.
  const fresh = !!h && connected && now - Date.parse(h.checkedAt) < STALE_MS;
  if (fresh) {
    if (h.diskFreeGb !== null && h.diskFreeGb < 5)
      out.push({ id: "disk", level: "bad", title: "Disk almost full: " + h.diskFreeGb + " GB free", fix: "Recordings stop when the disk fills up. Free some space on this PC, or keep clip files for fewer days below." });
    else if (h.diskFreeGb !== null && h.diskFreeGb < 15)
      out.push({ id: "disk", level: "warn", title: "Disk space is getting low: " + h.diskFreeGb + " GB free", fix: "A long stream can take several GB. Free some space, or keep clip files for fewer days below." });
    if (!h.ffmpeg) out.push({ id: "ffmpeg", level: "bad", title: "ffmpeg isn't working", fix: "Clips can't be cut or rendered without it. Reinstall it (winget install ffmpeg) and restart the PC's worker." });
    if (!h.streamlink) out.push({ id: "streamlink", level: "bad", title: "streamlink isn't working", fix: "Live streams can't be checked or recorded without it. Run: py -m pip install -U streamlink" });
    if (!h.whisper) out.push({ id: "whisper", level: "bad", title: "Speech-to-text (Whisper) isn't installed", fix: "Subtitles, sentence-aware cuts and post text need it. Run: py -m pip install -U faster-whisper" });
    else if (h.whisperReady === false)
      out.push({ id: "whisper-model", level: "info", title: "The " + h.whisperModel + " speech model will download with the next clip", fix: "About " + (MODEL_SIZE[h.whisperModel] ?? "a few hundred MB") + ", once. That clip takes a little longer." });
    if (h.ollama === "down") out.push({ id: "ollama", level: "warn", title: "The local AI writer (Ollama) isn't answering", fix: "Opening titles and post text fall back to the transcript, and quiet stretches aren't rated. Start Ollama on this PC, or turn the local AI writer off below." });
    else if (h.ollama === "ok" && h.ollamaMissing.length)
      out.push({ id: "ollama-model", level: "warn", title: "Ollama is missing " + h.ollamaMissing.join(" and "), fix: "Run on this PC: " + h.ollamaMissing.map(m => "ollama pull " + m).join(" then ") });
    if (h.codeChanged && !device.restartPending)
      out.push({ id: "update", level: "warn", title: "An update is waiting for a restart", fix: "The worker's files changed since it started. Restart it to use them; it waits until nothing is recording or being made.", action: "restart" });
  }
  if (connected && device?.restartPending)
    out.push({ id: "restarting", level: "info", title: "Restarting once idle", fix: device.recording?.length ? "Waiting for " + device.recording.length + " recording" + (device.recording.length === 1 ? "" : "s") + " to end." : device.making ? "Waiting for the clip being made to finish." : "Within a minute." });
  if (connected && (device?.oldestWaitMin ?? 0) >= 30)
    out.push({ id: "behind", level: "warn", title: "Falling behind: a clip has waited " + formatWait(device.oldestWaitMin), fix: "Clips arrive faster than this PC makes them. Raise computer usage, record fewer channels at once, or choose Faster transcription." });
  const rank = { bad: 0, warn: 1, info: 2 };
  return out.sort((a, b) => rank[a.level] - rank[b.level]);
}

function formatWait(min) { return min >= 120 ? Math.round(min / 60) + " hours" : min + " minutes"; }
