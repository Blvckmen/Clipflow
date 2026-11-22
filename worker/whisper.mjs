// Transcription without reloading Whisper for every clip: one long-running `captions.py serve` process keeps each
// model it has used loaded and takes one request per line. Starting Python and loading the "small" model was a fixed
// cost on every clip. The process exits after IDLE_MS without work (freeing about 1 GB), is stopped when a request is
// cancelled or runs too long (a Whisper run can't be interrupted otherwise), and a request it can't serve (it failed
// to start, or crashed) is run the old way, in a process of its own. WHISPER_SERVER=off always uses the old way.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { command } from "./process.mjs";

const script = fileURLToPath(new URL("./captions.py", import.meta.url));
const IDLE_MS = 30 * 60_000;
let server = null;  // { child, pending: Map<id, { resolve, reject }>, buffer, idle }
let seq = 0;

function stopServer(reason) {
  const s = server;
  if (!s) return;
  server = null;
  clearTimeout(s.idle);
  try { s.child.kill(); } catch { /* already gone */ }
  for (const { reject } of s.pending.values()) reject(new Error(reason));
  s.pending.clear();
}

function startServer(python) {
  const child = spawn(python, [script, "serve"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const s = { child, pending: new Map(), buffer: "", idle: null };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    s.buffer += chunk;
    let at;
    while ((at = s.buffer.indexOf("\n")) >= 0) {
      const line = s.buffer.slice(0, at).trim();
      s.buffer = s.buffer.slice(at + 1);
      if (!line) continue;
      let reply;
      try { reply = JSON.parse(line); } catch { continue; }
      const waiting = s.pending.get(reply.id);
      if (!waiting) continue;
      s.pending.delete(reply.id);
      if (reply.ok) waiting.resolve(); else waiting.reject(new Error(String(reply.error ?? "transcription failed").slice(0, 300)));
    }
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", d => { stderr = (stderr + d).slice(-2000); });
  child.on("error", error => { if (server === s) stopServer("transcriber could not start (" + error.message + ")"); });
  child.on("exit", code => { if (server === s) stopServer("transcriber stopped (exit " + code + ")" + (stderr.trim() ? ": " + stderr.trim().split("\n").pop() : "")); });
  return s;
}

// Writes Whisper's words for `source` to `target` (captions.py's {"segments": [...]} JSON).
// model: a Whisper model name ("small" unless WHISPER_MODEL says otherwise); hint: names and titles to spell right.
export async function transcribe(source, target, { hint = "", model = process.env.WHISPER_MODEL || "small", python = process.env.PYTHON || "python", signal, timeout = 600_000 } = {}) {
  const oneShot = () => command(python, [script, "words", source, target, String(hint).slice(0, 200)], { signal, timeout, env: { ...process.env, WHISPER_MODEL: model } }).done;
  if ((process.env.WHISPER_SERVER ?? "on").toLowerCase() === "off") return oneShot();
  if (signal?.aborted) throw new Error("Cancelled");
  server ??= startServer(python);
  const s = server, id = ++seq;
  clearTimeout(s.idle);
  const done = new Promise((resolve, reject) => s.pending.set(id, { resolve, reject }));
  // Cancelled or too slow: stop the process (the next request starts a fresh one).
  const timer = setTimeout(() => { if (s.pending.has(id)) stopServer("transcription timed out"); }, timeout);
  const abort = () => { if (s.pending.has(id)) stopServer("Cancelled"); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    s.child.stdin.write(JSON.stringify({ id, source, target, hint: String(hint).slice(0, 200), model }) + "\n");
    await done;
  } catch (error) {
    if (signal?.aborted || /timed out/.test(error.message)) throw error;
    // The process couldn't do it (failed to start, or crashed): the old way, once.
    console.warn("Transcriber process failed (" + error.message + "); transcribing in a separate process");
    return oneShot();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    if (server === s && !s.pending.size) s.idle = setTimeout(() => { if (server === s && !s.pending.size) stopServer("idle"); }, IDLE_MS);
  }
}

export function stopTranscriber() { stopServer("worker stopping"); }
