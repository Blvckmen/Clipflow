// Automatic opening titles from the same timed transcript used for subtitles.
// Self-contained inside worker/ so standalone and Docker workers need no app dependencies.
import { maskWord } from './edit.mjs';
const filler = /^(?:[\s,.!?-]|uh|um|hmm|ah|oh|yeah|yes|no|okay|ok|like|you know)+$/i;
const clean = text => String(text).replace(/[{}\\<>\r\n]/g, '').replace(/\s+/g, ' ').trim();
function fit(text, max = 72) {
  if (text.length <= max) return text;
  let head = text.slice(0, max - 1);
  // Do not leave half of a surrogate pair at the end.
  head = head.replace(/[\uD800-\uDBFF]$/, '');
  const boundary = head.lastIndexOf(' ');
  if (boundary > max / 2) head = head.slice(0, boundary);
  return head.trimEnd() + '\u2026';
}
/** @param {unknown} words @param {{start:number,end:number}} trim */
export function generateHook(words, trim, { mask = false } = {}) {
  return rankHooks(words, trim, { mask })[0] ?? '';
}
// Openers that fit any clip, offered when what was said gives fewer than `count` titles. They claim nothing about
// what happens; {name} is the streamer's name (left out when not known).
export const GENERIC_HOOKS = ['Wait for it…', 'Watch till the end', '{name} was NOT ready for this', 'Nobody expected this'];
/**
 * Up to `count` different opening titles to pick from: the best lines said in the trim (as generateHook ranks them),
 * then generic openers if there aren't enough. source: "said" (from the transcript) or "generic".
 * @returns {{ text: string, source: 'said' | 'generic' }[]}
 */
export function suggestHooks(words, trim, { mask = false, count = 3, name = '' } = {}) {
  const said = rankHooks(words, trim, { mask }), seen = new Set(), out = [];
  for (const text of said) { const key = text.toLowerCase(); if (!seen.has(key) && out.length < count) { seen.add(key); out.push({ text, source: 'said' }); } }
  const who = clean(name).slice(0, 30);
  for (const g of GENERIC_HOOKS) {
    if (out.length >= count) break;
    if (g.includes('{name}') && !who) continue;
    out.push({ text: g.replace('{name}', who), source: 'generic' });
  }
  return out;
}
function rankHooks(words, trim, { mask = false } = {}) {
  if (!Array.isArray(words) || !trim || !Number.isFinite(trim.start) || !Number.isFinite(trim.end)) return [];
  const selected = words.filter(w => Array.isArray(w) && Number.isFinite(w[0]) && Number.isFinite(w[1]) && w[0] >= trim.start && w[1] <= trim.end && w[1] >= w[0] && typeof w[2] === 'string' && w[2].trim())
    .map(([start,end,text]) => ({ start, end, text: clean(mask ? maskWord(text) : text) })).filter(w => w.text);
  // Break on sentence ends or pauses. This avoids joining unrelated spoken phrases.
  const phrases = []; let current = [];
  for (const word of selected) {
    if (current.length && word.start - current.at(-1).end > .8) { phrases.push(current); current = []; }
    current.push(word);
    if (/[.!?]["'\u201d]*$/.test(word.text)) { phrases.push(current); current = []; }
  }
  if (current.length) phrases.push(current);
  const ranked = phrases.map((phrase, index) => {
    const text = phrase.map(w => w.text).join(' ').replace(/\s+([,.!?;:])/g, '$1');
    const tokens = text.match(/[\p{L}\p{N}]+/gu) ?? [];
    const unique = new Set(tokens.map(w => w.toLowerCase())).size;
    // Prefer a readable, informative line or question, without inventing a claim.
    const score = Math.min(unique, 10) + (/\?$/.test(text) ? 3 : /!$/.test(text) ? 1 : 0) + (text.length <= 72 ? 2 : 0) - Math.max(0, tokens.length - 16) * .2;
    return { text, score, index, usable: tokens.length >= 3 && unique >= 3 && !filler.test(text) };
  }).filter(p => p.usable).sort((a,b) => b.score - a.score || a.index - b.index);
  return ranked.map(p => fit(p.text));
}
// Called only for a newly captured clip, not when rendering a user's saved edit.
export function applyAutomaticHook(edit, words, { enabled = true } = {}) {
  if (!enabled || edit.hook.text?.trim()) return edit;
  const text = generateHook(edit.words ?? words, edit.trim, { mask: !!edit.captions.mask });
  if (!text) return edit;
  // The look's hook length (5 seconds unless changed), longer if the hook needs more reading time; never past the end.
  const seconds = Math.min(edit.trim.end - edit.trim.start, Math.max(edit.hook?.seconds ?? 5, Math.ceil(text.split(/\s+/).length / 3)));
  return { ...edit, hook: { ...edit.hook, text, seconds } };
}
