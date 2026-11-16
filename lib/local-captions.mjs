// Pure local caption composition. No model, network request, or API key.
const stop = new Set('about after again also always because before being could doing every first from going have here into just like more most much need only other really said some something than that their them there these they thing think this those through very want were what when where which while will with would your you are and but for not the then now can was how our out its has had get got all'.split(' '));
export const characterCount = text => Array.from(text).length;
export function shorten(text, max) {
  const clean = String(text ?? '').replace(/\s+/gu, ' ').trim();
  if (characterCount(clean) <= max) return clean;
  const cut = Array.from(clean).slice(0, Math.max(0, max - 1)).join('');
  const boundary = cut.lastIndexOf(' ');
  return (boundary > cut.length * .6 ? cut.slice(0, boundary) : cut).trimEnd() + '\u2026';
}
/** @param {unknown} words @param {{start:number,end:number}|null} trim */
export function transcriptText(words, trim = null) {
  if (!Array.isArray(words)) return '';
  return words.filter(w => Array.isArray(w) && Number.isFinite(w[0]) && Number.isFinite(w[1]) && typeof w[2] === 'string' && w[2].trim() && (!trim || (w[0] >= trim.start - .05 && w[1] <= trim.end + .05)))
    .map(w => w[2].trim()).join(' ').replace(/\s+([,.!?;:])/g, '$1').slice(0, 12000).trim();
}
export function keywordTags(text, extra = [], limit = 4) {
  const counts = new Map();
  for (const word of text.match(/[\p{L}][\p{L}\p{N}_]{3,29}/gu) ?? []) {
    const key = word.toLowerCase();
    if (!stop.has(key)) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const candidates = [...extra, ...[...counts].sort((a,b) => b[1]-a[1]).map(([key]) => key)];
  const seen = new Set(), tags = [];
  for (const item of candidates) {
    const tag = Array.from(String(item).replace(/[^\p{L}\p{N}_]/gu, '')).slice(0, 30).join('');
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase()); tags.push('#' + tag);
    if (tags.length >= limit) break;
  }
  return tags;
}
export function selectExcerpt(text, max = 160) {
  const sentences = String(text).replace(/\s+/g, ' ').trim().match(/[^.!?]+[.!?]*/g) ?? [];
  const ranked = sentences.map((s, i) => ({ text: s.trim(), score: keywordTags(s, [], 8).length + (/\?\s*$/.test(s) ? 1 : 0), i }))
    .filter(s => s.text.length >= 10).sort((a,b) => b.score-a.score || a.i-b.i);
  return shorten(ranked[0]?.text ?? text, max);
}
const leads = {
  Casual: ['From the clip', 'One moment to share', 'Worth a replay'],
  Funny: ['The replay button is right there', 'Straight from the clip', 'Press play, then tell us'],
  Professional: ['Clip excerpt', 'In focus', 'From the recording'],
  Inspirational: ['A moment to reflect on', 'Take a moment', 'A thought to share'],
  Bold: ['HEAR THIS', 'PRESS PLAY', 'IN THEIR WORDS'],
};
export function localDrafts({ text, streamer = '', tone = 'Casual', length = 'Medium', platform = 'Instagram', emojis = true, hashtags = true, extraTags = [] }) {
  const limit = Math.min(({ Short: 240, Medium: 700, Long: 1400 })[length] ?? 700, platform === 'X' ? 280 : Infinity);
  const source = String(text).replace(/\s+/g, ' ').trim();
  if (!source) throw new Error('No transcript is available. Enable Transcribe clips for future recordings, or enter a description.');
  const cleaned = (emojis ? source : source.replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3\uFE0F\u200d]/gu, '')).replace(hashtags ? /$^/ : /#/g, '');
  const safeStreamer = (emojis ? streamer : streamer.replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3\uFE0F\u200d]/gu, '')).replace(hashtags ? /$^/ : /#/g, '');
  if (!cleaned.trim()) throw new Error('Please include some words in your description.');
  const credit = safeStreamer ? '\n\nClip: ' + shorten(safeStreamer, 60) : '';
  const tags = hashtags ? keywordTags(cleaned, [streamer, ...extraTags].filter(Boolean), platform === 'X' || length === 'Short' ? 2 : 4).join(' ') : '';
  const suffix = credit + (tags ? '\n\n' + tags : '');
  const options = leads[tone] ?? leads.Casual;
  const captions = options.map((lead, i) => {
    const prefix = (emojis ? ['\u{1f3ac} ', '\u{1f4ac} ', '\u{25b6}\ufe0f '][i] : '') + lead + '\n\n';
    const budget = Math.max(20, limit - characterCount(prefix + suffix));
    const excerpt = selectExcerpt(cleaned, Math.min(budget, length === 'Short' ? 110 : length === 'Medium' ? 320 : 700));
    return prefix + excerpt + suffix;
  });
  return { captions, limit, method: 'local' };
}
