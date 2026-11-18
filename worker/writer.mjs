// Writes a clip's on-screen hook and its post caption with a small language model running on this machine through
// Ollama (https://ollama.com). Free and private, but optional: if Ollama isn't running, is slow or answers oddly,
// this returns null and the clip keeps the transcript-based hook and caption, so nothing ever waits on it.
// Settings: AI_WRITER=off turns it off; OLLAMA_URL (default http://127.0.0.1:11434); OLLAMA_MODEL (default qwen2.5:7b;
// qwen2.5:3b is twice as fast with weaker hooks).
const URL_DEFAULT = "http://127.0.0.1:11434", MODEL_DEFAULT = "qwen2.5:7b";
export const writerEnabled = () => (process.env.AI_WRITER ?? "on").toLowerCase() !== "off";

const schema = {
  type: "object",
  properties: {
    hook: { type: "string", description: "On-screen title, at most 8 words" },
    caption: { type: "string", description: "One or two sentences for the post, no hashtags" },
    hashtags: { type: "array", items: { type: "string" }, description: "Up to 3 topic hashtags without #" },
  },
  required: ["hook", "caption", "hashtags"],
};

const clean = text => String(text ?? "").replace(/[\r\n{}\\<>]/g, " ").replace(/\s+/g, " ").trim();
const tag = text => String(text ?? "").replace(/^#+/, "").replace(/[^\p{L}\p{N}_]/gu, "").slice(0, 30);

// The few lines of chat around the moment that say most about it: distinct messages, most repeated first.
export function chatSample(lines, fromMs, toMs, max = 25) {
  const counts = new Map();
  for (const { t, text } of lines ?? []) {
    if (t < fromMs || t > toMs) continue;
    const key = clean(text).slice(0, 80);
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, max).map(([text, n]) => n > 1 ? text + " (x" + n + ")" : text);
}

export function buildPrompt({ transcript, streamer, platform, title, chat }) {
  return [
    "Write the text for a short vertical video clipped from a live stream.",
    "Streamer: " + (streamer || "unknown") + " on " + (platform || "a stream"),
    title ? "Stream title: " + clean(title).slice(0, 150) : "",
    "What was said in the clip (automatic transcript, may contain mistakes):\n" + (clean(transcript).slice(0, 1500) || "(no speech)"),
    chat?.length ? "What chat said at that moment:\n" + chat.join("\n").slice(0, 800) : "",
    "Return JSON with:",
    "- hook: an on-screen title of 3 to 8 words that makes people stop scrolling: a reaction, a tease or a bold claim about the moment, like 'He did NOT expect that', 'Chat was not ready for this' or 'This speech went too hard'. Not a summary or a label. Base it only on what happens in the clip; don't invent names, numbers or events. No hashtags, no quotation marks.",
    "- caption: one or two short, casual sentences for the post that add to the hook, in the same language as the clip. The person talking may not be the streamer (a guest, a caster, a video on stream), so don't say who said what unless it's clear. No hashtags.",
    "- hashtags: up to 3 topic hashtags without the # sign (e.g. the game or what happens).",
  ].filter(Boolean).join("\n\n");
}

// Tidies the model's answer; null when it isn't usable.
export function tidy(answer, { streamer, platform } = {}) {
  let hook = clean(answer?.hook).replace(/^["'“‘]+|["'”’]+$/g, "").replace(/#[\p{L}\p{N}_]+/gu, "").replace(/\s+/g, " ").trim();
  const words = hook.split(" ").filter(Boolean);
  if (words.length > 10) hook = words.slice(0, 10).join(" ");
  hook = hook.replace(/[.,;:]+$/, "").slice(0, 72);
  const text = clean(answer?.caption).replace(/#[\p{L}\p{N}_]+/gu, "").replace(/\s+/g, " ").trim().slice(0, 500);
  if (hook.split(" ").filter(w => /[\p{L}\p{N}]/u.test(w)).length < 2 || text.length < 5) return null;
  const tags = [...new Set([tag(streamer), ...(Array.isArray(answer?.hashtags) ? answer.hashtags.map(tag) : []), "clips"].filter(Boolean).map(t => t.toLowerCase()))].slice(0, 5);
  const credit = streamer ? "\n\n\u{1F3A5} " + streamer + (platform ? " on " + platform : "") : "";
  return { hook, caption: text + credit + "\n\n" + tags.map(t => "#" + t).join(" ") };
}

export async function writeClipText(input, { signal, timeoutMs = 150_000 } = {}) {
  if (!writerEnabled()) return null;
  const base = (process.env.OLLAMA_URL || URL_DEFAULT).replace(/\/$/, "");
  try {
    const response = await fetch(base + "/api/chat", {
      method: "POST", headers: { "content-type": "application/json" },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        model: process.env.OLLAMA_MODEL || MODEL_DEFAULT, stream: false, format: schema, keep_alive: "30m",
        options: { temperature: 0.7, num_ctx: 2048, num_predict: 220 },
        messages: [
          { role: "system", content: "You write titles and captions for short clips of live streams. You only describe what is in the clip, and you answer with JSON." },
          { role: "user", content: buildPrompt(input) },
        ],
      }),
    });
    if (!response.ok) return null;
    const body = await response.json();
    return tidy(JSON.parse(body?.message?.content ?? "null"), input);
  } catch { return null; }
}
