// Writes a clip's on-screen hook and its post caption with a small language model running on this machine through
// Ollama (https://ollama.com). Free and private, but optional: if Ollama isn't running, is slow or answers oddly,
// this returns null and the clip keeps the transcript-based hook and caption, so nothing ever waits on it.
// Settings: AI_WRITER=off turns it off; OLLAMA_URL (default http://127.0.0.1:11434); OLLAMA_MODEL (default qwen2.5:7b;
// qwen2.5:3b is twice as fast with weaker hooks).
const URL_DEFAULT = "http://127.0.0.1:11434", MODEL_DEFAULT = "qwen2.5:7b", PICKER_MODEL_DEFAULT = "qwen2.5:3b";
// A number of seconds from the environment as milliseconds, or the default.
const seconds = (value, fallback) => (Number(value) > 0 ? Number(value) : fallback) * 1000;
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

// Up to 75 seconds: past that the clip keeps the transcript-based hook and caption rather than waiting (AI_WRITER_TIMEOUT
// in seconds changes it).
export async function writeClipText(input, { signal, timeoutMs = seconds(process.env.AI_WRITER_TIMEOUT, 75) } = {}) {
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

// ---- Picking moments by what was said ----
// Rates candidate moments of a stream by their transcripts, 0..10 each, for how well each would work as a short
// clip on its own. One request for all of them. Null when Ollama is off, slow or answers oddly: the moment is then
// picked from loudness and chat alone. AI_PICKER=off turns only this off.
export const pickerEnabled = () => writerEnabled() && (process.env.AI_PICKER ?? "on").toLowerCase() !== "off";

const rateSchema = {
  type: "object",
  properties: { scores: { type: "array", items: { type: "integer", minimum: 0, maximum: 10 }, description: "One score per moment, in order" } },
  required: ["scores"],
};

export function buildRatePrompt(texts, { streamer, title, chat }) {
  return [
    "These are " + texts.length + " candidate moments from the same live stream" + (streamer ? " by " + streamer : "") + ". Only one becomes a short vertical clip.",
    title ? "Stream title: " + clean(title).slice(0, 150) : "",
    chat?.length ? "What chat said around then:\n" + chat.join("\n").slice(0, 500) : "",
    ...texts.map((t, i) => "Moment " + (i + 1) + " (automatic transcript, may contain mistakes):\n" + (clean(t).slice(0, 700) || "(no speech)")),
    "Score each moment from 0 to 10 for how well it works as a short clip on its own: it grabs attention in the first seconds, has a payoff (a joke landing, a reaction, a reveal, a strong opinion, a story ending), and makes sense without the rest of the stream.",
    "Score low: filler, reading out donations or settings, silence, waiting, a sentence cut off in the middle, or talk that needs context.",
    "Return JSON: {\"scores\": [one integer per moment, in order]}.",
  ].filter(Boolean).join("\n\n");
}

// Up to 60 seconds, with the smaller model (OLLAMA_PICKER_MODEL, default qwen2.5:3b, about twice as fast; a rough 0-10
// score doesn't need the bigger one): past that the moment is picked from loudness and chat (AI_PICKER_TIMEOUT).
export async function rateMoments(texts, context = {}, { signal, timeoutMs = seconds(process.env.AI_PICKER_TIMEOUT, 60) } = {}) {
  if (!pickerEnabled() || texts.length < 2 || texts.every(t => !clean(t))) return null;
  const base = (process.env.OLLAMA_URL || URL_DEFAULT).replace(/\/$/, "");
  try {
    const response = await fetch(base + "/api/chat", {
      method: "POST", headers: { "content-type": "application/json" },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        model: process.env.OLLAMA_PICKER_MODEL || PICKER_MODEL_DEFAULT, stream: false, format: rateSchema, keep_alive: "30m",
        options: { temperature: 0.2, num_ctx: 4096, num_predict: 60 },
        messages: [
          { role: "system", content: "You pick the best moments of live streams for short clips. You answer with JSON." },
          { role: "user", content: buildRatePrompt(texts, context) },
        ],
      }),
    });
    if (!response.ok) return null;
    const scores = JSON.parse((await response.json())?.message?.content ?? "null")?.scores;
    return Array.isArray(scores) && scores.length === texts.length && scores.every(s => Number.isFinite(s)) ? scores.map(s => Math.max(0, Math.min(10, s))) : null;
  } catch { return null; }
}

// ---- Translating a clip for accounts that post in another language ----
export const LANGUAGE_NAMES = { es: "Latin American Spanish", pt: "Brazilian Portuguese", fr: "French" };

// Transcript words [[start, end, text]] grouped into sentences, for translating whole thoughts rather than words.
// Breaks after . ? !, at pauses over 0.8s, and every 14 words.
export function sentencesOf(words) {
  const out = [];
  let cur = [];
  const flush = () => { if (cur.length) out.push({ start: cur[0][0], end: cur.at(-1)[1], text: cur.map(w => w[2]).join(" ").replace(/\s+/g, " ").trim() }); cur = []; };
  for (const w of words ?? []) {
    if (!String(w[2] ?? "").trim()) continue;
    if (cur.length && (w[0] - cur.at(-1)[1] > 0.8 || cur.length >= 14)) flush();
    cur.push(w);
    if (/[.?!]["')\]]*$/.test(String(w[2]).trim())) flush();
  }
  flush();
  return out.filter(s => s.text);
}

// A translated sentence as timed words over the original sentence's span, each word's share by its length, so the
// subtitles keep pace with the speech.
export function spreadWords(sentence, translated) {
  const parts = String(translated ?? "").replace(/[\r\n{}\\<>]/g, " ").split(/\s+/).filter(Boolean);
  if (!parts.length) return [];
  const span = Math.max(0.2, sentence.end - sentence.start), total = parts.reduce((a, p) => a + p.length + 1, 0);
  let t = sentence.start;
  return parts.map(p => { const d = span * (p.length + 1) / total, w = [Math.round(t * 100) / 100, Math.round((t + d) * 100) / 100, p.slice(0, 40)]; t += d; return w; });
}

const translateSchema = {
  type: "object",
  properties: { sentences: { type: "array", items: { type: "string" } }, hook: { type: "string" }, caption: { type: "string" } },
  required: ["sentences", "hook", "caption"],
};

export function buildTranslatePrompt({ sentences, hook, caption, names = [] }, lang) {
  const keep = names.map(n => clean(n)).filter(Boolean);
  return [
    "Translate this short vertical video clip from a live stream into " + LANGUAGE_NAMES[lang] + ".",
    // Streamer names are often ordinary words ("Speed"), which a translator would otherwise translate.
    keep.length ? "These are names: keep them exactly as written, never translate them: " + keep.join(", ") + "." : "",
    "Keep it natural and casual, the way people talk on stream and in comments; keep names, gamer slang that's used as is (GG, W, L, clutch), emotes (KEKW, LUL) and hashtags unchanged.",
    "Translate every subtitle line separately, in order: exactly " + sentences.length + " lines back, one per line given, each about as long as the original.",
    "Return JSON: {\"sentences\": [...], \"hook\": \"...\", \"caption\": \"...\"}.",
    JSON.stringify({ sentences: sentences.map(s => s.text), hook: hook || "", caption: caption || "" }),
  ].filter(Boolean).join("\n\n");
}

// { sentences: [translated text per sentence], hook, caption } or null when Ollama is off, slow or answers oddly.
export async function translateClip(input, lang, { signal, timeoutMs = 240_000 } = {}) {
  if (!LANGUAGE_NAMES[lang] || !writerEnabled()) return null;
  const base = (process.env.OLLAMA_URL || URL_DEFAULT).replace(/\/$/, "");
  try {
    const response = await fetch(base + "/api/chat", {
      method: "POST", headers: { "content-type": "application/json" },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        model: process.env.OLLAMA_MODEL || MODEL_DEFAULT, stream: false, format: translateSchema, keep_alive: "30m",
        options: { temperature: 0.2, num_ctx: 8192, num_predict: 3000 },
        messages: [
          { role: "system", content: "You translate subtitles and captions for short stream clips. You answer with JSON." },
          { role: "user", content: buildTranslatePrompt(input, lang) },
        ],
      }),
    });
    if (!response.ok) return null;
    const out = JSON.parse((await response.json())?.message?.content ?? "null");
    if (!out || !Array.isArray(out.sentences) || out.sentences.length !== input.sentences.length || out.sentences.some(s => typeof s !== "string")) return null;
    return { sentences: out.sentences, hook: clean(out.hook).slice(0, 90), caption: String(out.caption ?? "").replace(/[{}\\<>]/g, "").trim().slice(0, 2000) };
  } catch { return null; }
}
