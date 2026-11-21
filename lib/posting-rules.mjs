// A streamer's posting rules: a credit line for the streamer, and a clipping campaign's requirements (an ad label,
// hashtags and mentions every post must carry, and the clip lengths it accepts), read from a pasted brief and then
// checked and edited by the owner. Applied to every post of that streamer's clips, whoever wrote the caption.

export const DEFAULT_CREDIT = "🎥 {streamer} on {platform}: {channel}";
export const MAX_CAPTION = 2200;
const LABELS = ["#ad", "#sponsored", "#partner", "#paidpartnership", "#promo"];

// The rules a streamer starts with: no credit line and no campaign, so posts are exactly as written until the owner
// switches them on.
export function emptyRules() {
  return { credit: false, creditText: DEFAULT_CREDIT, label: "", hashtags: [], mentions: [], minSeconds: null, maxSeconds: null, brief: "" };
}

// Rules read from stored JSON (or anything else): only known fields, of the right kind and size.
export function readRules(value) {
  let v = value;
  if (typeof v === "string") { try { v = JSON.parse(v); } catch { v = null; } }
  const base = emptyRules();
  if (!v || typeof v !== "object" || Array.isArray(v)) return base;
  const tags = (list, mark) => Array.isArray(list) ? [...new Set(list.filter(t => typeof t === "string").map(t => normalizeTag(t, mark)).filter(Boolean))].slice(0, 15) : [];
  const seconds = n => Number.isInteger(n) && n >= 5 && n <= 600 ? n : null;
  const rules = {
    credit: typeof v.credit === "boolean" ? v.credit : base.credit,
    creditText: typeof v.creditText === "string" && v.creditText.trim() ? v.creditText.trim().slice(0, 200) : base.creditText,
    label: typeof v.label === "string" ? v.label.trim().slice(0, 40) : "",
    hashtags: tags(v.hashtags, "#"), mentions: tags(v.mentions, "@"),
    minSeconds: seconds(v.minSeconds), maxSeconds: seconds(v.maxSeconds),
    brief: typeof v.brief === "string" ? v.brief.slice(0, 4000) : "",
  };
  if (rules.minSeconds && rules.maxSeconds && rules.minSeconds > rules.maxSeconds) [rules.minSeconds, rules.maxSeconds] = [rules.maxSeconds, rules.minSeconds];
  return rules;
}

// "#Clips" -> "#clips"; "@Kai.Cenat" stays as typed after the mark; anything that isn't a tag -> "".
function normalizeTag(text, mark) {
  const body = String(text).trim().replace(/^[#@]+/, "");
  if (!/^[\p{L}\p{N}_.]{1,50}$/u.test(body)) return "";
  return mark + (mark === "#" ? body.toLowerCase() : body);
}

// Reads a campaign brief pasted from Discord, Whop, an email...: hashtags and mentions it asks for, an ad label, the
// clip lengths it accepts, and whether the streamer must be credited. Only what it finds is returned.
export function parseBrief(text) {
  const brief = String(text ?? "").slice(0, 4000), lower = brief.toLowerCase(), found = {};
  const allTags = [...brief.matchAll(/(^|[^\p{L}\p{N}_&])#([\p{L}\p{N}_]{2,50})/gu)].map(m => "#" + m[2].toLowerCase());
  const label = LABELS.find(l => allTags.includes(l)) ?? (/\bpaid partnership\b|\bsponsored\b|\bdisclos/.test(lower) ? "#ad" : "");
  if (label) found.label = label;
  const hashtags = [...new Set(allTags.filter(t => !LABELS.includes(t)))];
  if (hashtags.length) found.hashtags = hashtags.slice(0, 15);
  const mentions = [...new Set([...brief.matchAll(/(^|[^\p{L}\p{N}_.@])@([A-Za-z0-9_.]{2,30})/gu)].map(m => "@" + m[2].replace(/\.$/, "")))];
  if (mentions.length) found.mentions = mentions.slice(0, 15);
  const sec = (n, unit) => Math.round(Number(n) * (/^m/.test(unit) ? 60 : 1));
  const unit = "(s|secs?|seconds?|m|mins?|minutes?)\\b";
  const range = new RegExp("(\\d+(?:\\.\\d+)?)\\s*(?:s|secs?|seconds?)?\\s*(?:-|–|—|to)\\s*(\\d+(?:\\.\\d+)?)\\s*" + unit).exec(lower);
  if (range) { found.minSeconds = sec(range[1], range[3]); found.maxSeconds = sec(range[2], range[3]); }
  else {
    const min = new RegExp("(?:at least|minimum(?: of)?|min\\.?|longer than|no shorter than|over)\\s*(\\d+(?:\\.\\d+)?)\\s*" + unit).exec(lower);
    const max = new RegExp("(?:under|at most|maximum(?: of)?|max\\.?|no longer than|shorter than|up to|less than)\\s*(\\d+(?:\\.\\d+)?)\\s*" + unit).exec(lower);
    if (min) found.minSeconds = sec(min[1], min[2]);
    if (max) found.maxSeconds = sec(max[1], max[2]);
  }
  if (/\bcredit\b|\btag (?:the )?(?:streamer|creator|channel)\b|\blink (?:to )?(?:the |their )?(?:channel|stream|twitch|kick)\b|\bmention (?:the )?(?:streamer|creator)\b/.test(lower)) found.credit = true;
  return found;
}

// The caption to post: the campaign's label first, then the caption, the credit line, and any required hashtags or
// mentions it doesn't already have. The caption itself is shortened (never the label, credit or tags) to fit.
export function applyRules(caption, rules, info) {
  const r = readRules(rules), text = String(caption ?? "").trim();
  const has = tag => new RegExp("(^|[^\\p{L}\\p{N}_])" + tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![\\p{L}\\p{N}_])", "iu").test(text);
  const head = r.label && !has(r.label) ? r.label : "";
  const credit = r.credit ? r.creditText.replace(/\{streamer\}/g, info.streamer ?? "").replace(/\{platform\}/g, info.platform ?? "").replace(/\{channel\}/g, info.channel ?? "").replace(/\s+([:,])\s*$/, "").trim() : "";
  const tags = [...r.mentions, ...r.hashtags].filter(t => !has(t)).join(" ");
  const tail = [credit, tags].filter(Boolean).join("\n\n");
  const room = MAX_CAPTION - (head ? head.length + 1 : 0) - (tail ? tail.length + 2 : 0);
  const body = text.length > room ? text.slice(0, Math.max(0, room - 1)).trimEnd() + "…" : text;
  return [[head, body].filter(Boolean).join(" "), tail].filter(Boolean).join("\n\n").slice(0, MAX_CAPTION);
}

// Why a clip this long can't go out under the rules, or null when it can.
export function lengthProblem(rules, seconds) {
  const r = readRules(rules);
  if (!Number.isFinite(seconds)) return null;
  if (r.minSeconds && seconds < r.minSeconds) return "the campaign wants clips of at least " + r.minSeconds + "s (this one is " + Math.round(seconds) + "s)";
  if (r.maxSeconds && seconds > r.maxSeconds) return "the campaign wants clips of at most " + r.maxSeconds + "s (this one is " + Math.round(seconds) + "s)";
  return null;
}
