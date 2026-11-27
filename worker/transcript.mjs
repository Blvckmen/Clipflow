// Transcript tools for the editor's Transcript step: find and replace, rewriting a stretch, nudging the timing, speaker
// names, and subtitle and transcript files. Pure functions over transcript words ([[start, end, text]], seconds from
// the source start; empty text hides a word), so the editor, the server and the tests share them.
// Self-contained inside worker/ like edit.mjs, which has the subtitle lines they match.
import { cues, maskWord, normalizeSpeakers, normalizeWords } from "./edit.mjs";

export { normalizeSpeakers };
const round = n => Math.round(n * 100) / 100;
const plain = edit => ({ cuts: [], length: edit.trim.end - edit.trim.start, toClip: t => t, punches: [] });
// A word's leading and trailing punctuation, and what's between (compared when finding).
const parts = text => { const m = /^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/su.exec(text); return { lead: m[1], core: m[2], trail: m[3] }; };
const terms = text => String(text ?? "").replace(/[{}\\\r\n]/g, " ").split(/\s+/).filter(Boolean);
// A word is at most 40 characters (normalizeWords): longer terms are cut.
const cap = t => t.slice(0, 40);

// The words `text` stands for, spread over [start, end] in proportion to their length (at least 0.05 s each).
function spread(text, start, end) {
  const list = terms(text).map(cap);
  if (!list.length) return [];
  const span = Math.max(end - start, 0.05 * list.length), total = list.reduce((n, t) => n + t.length + 1, 0);
  let at = start;
  return list.map((t, i) => { const s = at, e = i === list.length - 1 ? start + span : at + span * (t.length + 1) / total; at = e; return [round(s), round(e), t]; });
}

/**
 * Replaces every match of `find` (one word or a phrase of whole words) with `replace`.
 * matchCase: compare letters exactly; wholeWord (one-word finds only): false also replaces inside words ("gg" in "eggs").
 * An empty `replace` removes the matched words. A match keeps the first word's leading and the last word's trailing
 * punctuation. The same number of words keeps each word's timing; otherwise the new words share the match's time.
 * @returns {{ words: [number, number, string][], count: number }}
 */
export function replaceWords(words, find, replace, { matchCase = false, wholeWord = true } = {}) {
  const want = terms(find), norm = s => matchCase ? s : s.toLowerCase();
  if (!want.length) return { words: words.map(w => [...w]), count: 0 };
  const out = [];
  let count = 0;
  // Inside words: a one-word find replaced wherever it appears in a word's letters.
  if (!wholeWord && want.length === 1) {
    const needle = want[0], flags = matchCase ? "g" : "gi", re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
    for (const [s, e, t] of words) {
      const next = t.replace(re, () => { count++; return terms(replace).join(" "); });
      if (next === t) { out.push([s, e, t]); continue; }
      out.push(...(terms(next).length > 1 ? spread(next, s, e) : [[s, e, cap(next.trim())]]));
    }
    return { words: out, count };
  }
  const goal = want.map(t => norm(parts(t).core));
  for (let i = 0; i < words.length;) {
    // The next len visible words from i must match; hidden (empty) words in between are skipped over.
    const at = [];
    for (let j = i; j < words.length && at.length < goal.length; j++) { if (!words[j][2]) { if (!at.length) break; continue; } at.push(j); }
    const hit = at.length === goal.length && at.every((j, k) => norm(parts(words[j][2]).core) === goal[k]);
    if (!hit) { out.push([...words[i]]); i++; continue; }
    count++;
    const first = words[at[0]], last = words[at.at(-1)], lead = parts(first[2]).lead, trail = parts(last[2]).trail, put = terms(replace);
    if (put.length) {
      put[0] = lead + put[0]; put[put.length - 1] += trail;
      if (put.length === at.length) at.forEach((j, k) => out.push([words[j][0], words[j][1], cap(put[k])]));
      else out.push(...spread(put.join(" "), first[0], last[1]));
    }
    i = at.at(-1) + 1;
  }
  return { words: out, count };
}

/** How many times `find` appears (the same rules as replaceWords), for "3 found" before replacing. */
export const countMatches = (words, find, options) => replaceWords(words, find, "\u0000", options).count;

/**
 * Words from..to (indexes, inclusive) rewritten as `text`, sharing their time: for correcting a line by typing it.
 * An empty text removes them.
 */
export function rewriteSpan(words, from, to, text) {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to >= words.length || from > to) throw new RangeError("Pick words that are in the transcript");
  return [...words.slice(0, from).map(w => [...w]), ...spread(text, words[from][0], words[to][1]), ...words.slice(to + 1).map(w => [...w])];
}

/**
 * Every word between `from` and `to` (source seconds) moved by `seconds` (negative: earlier), for subtitles that
 * show a little early or late. Times stay at or above 0.
 */
export function shiftWords(words, seconds, { from = -Infinity, to = Infinity } = {}) {
  if (!Number.isFinite(seconds) || Math.abs(seconds) > 10) throw new RangeError("Move the subtitles by at most 10 seconds");
  return words.map(([s, e, t]) => s >= from && s <= to ? [round(Math.max(0, s + seconds)), round(Math.max(0, e + seconds)), t] : [s, e, t]);
}

/** The name speaking at `t` (source seconds), or "" when nobody is named. */
export function speakerAt(speakers, t) {
  let name = "";
  for (const s of speakers ?? []) { if (s.at <= t + 1e-6) name = s.name; else break; }
  return name;
}

// The edit's own corrected words when it has them, else the clip's transcript.
const wordsOf = (edit, words) => edit.words ?? words ?? [];

/**
 * The subtitle lines as they appear on the video: the same lines, capitals and bleeps, at their times in the finished
 * clip (`tl`: the timeline from edit.mjs, after any jump cuts). speaker: who is speaking when the line starts.
 * @returns {{ start: number, end: number, text: string, speaker: string }[]}
 */
export function subtitleLines(edit, words, tl = plain(edit)) {
  return cues(wordsOf(edit, words), edit).map(c => ({ start: round(tl.toClip(c.start)), end: round(tl.toClip(c.end)), text: c.words.map(w => w.t).join(" "), speaker: speakerAt(edit.speakers, c.start + edit.trim.start) }))
    .filter(l => l.end - l.start >= 0.05 && l.text);
}

const stamp = (t, sep) => { const ms = Math.max(0, Math.round(t * 1000)); return [Math.floor(ms / 3600000), Math.floor(ms / 60000) % 60, Math.floor(ms / 1000) % 60].map(n => String(n).padStart(2, "0")).join(":") + sep + String(ms % 1000).padStart(3, "0"); };

/** SubRip (.srt) subtitles of the finished clip. */
export function toSrt(edit, words, tl) {
  return subtitleLines(edit, words, tl).map((l, i) => `${i + 1}\n${stamp(l.start, ",")} --> ${stamp(l.end, ",")}\n${l.text}\n`).join("\n");
}

/** WebVTT (.vtt) subtitles of the finished clip; named speakers as voice tags (<v Name>). */
export function toVtt(edit, words, tl) {
  const safe = t => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return "WEBVTT\n\n" + subtitleLines(edit, words, tl).map(l => `${stamp(l.start, ".")} --> ${stamp(l.end, ".")}\n${l.speaker ? `<v ${safe(l.speaker)}>` : ""}${safe(l.text)}\n`).join("\n");
}

/**
 * A plain-text transcript of what's said in the trim, a paragraph per speaker turn or long pause (as said: not in
 * subtitle capitals; swear words bleeped when the subtitles bleep them). timestamps: "[m:ss] " before each paragraph,
 * in finished-clip time.
 */
export function toTxt(edit, words, { timestamps = false, tl = plain(edit) } = {}) {
  const { start, end } = edit.trim, paras = [];
  let cur = null;
  for (const [s, e, raw] of wordsOf(edit, words)) {
    if (!raw || s < start - 0.05 || e > end + 0.05) continue;
    const who = speakerAt(edit.speakers, s), t = edit.captions?.mask ? maskWord(raw) : raw;
    if (!cur || who !== cur.who || s - cur.last > 2) { cur = { who, at: s - start, words: [] }; paras.push(cur); }
    cur.words.push(t); cur.last = e;
  }
  const clock = t => { const n = Math.max(0, Math.round(tl.toClip(t))); return Math.floor(n / 60) + ":" + String(n % 60).padStart(2, "0"); };
  return paras.map(p => (timestamps ? "[" + clock(p.at) + "] " : "") + (p.who ? p.who + ": " : "") + p.words.join(" ")).join("\n\n") + (paras.length ? "\n" : "");
}

/** The file for a download: its text, file name ending and content type. */
export const SUBTITLE_FORMATS = { srt: "application/x-subrip", vtt: "text/vtt", txt: "text/plain" };
export function subtitleFile(format, edit, words, tl) {
  if (!(format in SUBTITLE_FORMATS)) throw new RangeError("Choose srt, vtt or txt");
  const body = format === "srt" ? toSrt(edit, words, tl) : format === "vtt" ? toVtt(edit, words, tl) : toTxt(edit, words, { tl, timestamps: true });
  return { body, type: SUBTITLE_FORMATS[format] + "; charset=utf-8", ext: format };
}

// Checks words produced here before they are saved in an edit (the same rules as edit.mjs).
export const checkWords = (words, total) => normalizeWords(words, total);
