// Pure highlight-detection helpers. Times are in seconds unless a name says otherwise.

// Counts events per whole second over [from, from + seconds); `times` are epoch milliseconds.
export function perSecond(times, fromMs, seconds) {
  const counts = new Array(Math.max(0, Math.ceil(seconds))).fill(0);
  for (const t of times) { const i = Math.floor((t - fromMs) / 1000); if (i >= 0 && i < counts.length) counts[i]++; }
  return counts;
}

const median = values => { if (!values.length) return 0; const s = [...values].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// A chat spike is a recent window well above the channel's own typical rate. Requires some history so a
// channel's normal pace is known before anything counts as unusual.
export function chatSpike(times, nowMs, { sinceMs, window = 10, history = 300, minHistory = 60, factor = 2.5, minCount = 6 } = {}) {
  const recent = times.filter(t => t > nowMs - window * 1000 && t <= nowMs).length;
  const span = Math.min(history, (nowMs - sinceMs) / 1000 - window);
  if (span < minHistory) return { spike: false, recent, baseline: null };
  const buckets = [];
  for (let end = nowMs - window * 1000; end - window * 1000 >= nowMs - (window + span) * 1000; end -= window * 1000)
    buckets.push(times.filter(t => t > end - window * 1000 && t <= end).length);
  const baseline = median(buckets);
  return { spike: recent >= minCount && recent >= factor * baseline + 2, recent, baseline };
}

const normalised = values => { const max = Math.max(0, ...values); return max > 0 ? values.map(v => v / max) : values.map(() => 0); };

// Best clip start in [from, to - duration], scoring each second by loudness and by chat activity `lag` seconds
// later (viewers react after the moment). Without chat the choice is loudness alone.
export function pickWindow({ energy, chat = [], duration, from = 0, to = energy.length, lag = 4 }) {
  const e = normalised(energy), c = normalised(chat), useChat = c.some(v => v > 0);
  const score = i => (e[i] ?? 0) * (useChat ? 0.5 : 1) + (useChat ? (c[i + lag] ?? 0) * 0.5 : 0);
  const last = Math.max(from, Math.min(to, energy.length) - duration);
  let best = from, bestScore = -1;
  for (let s = from; s <= last; s++) {
    let total = 0;
    for (let i = s; i < s + duration; i++) total += score(i);
    if (total > bestScore) { bestScore = total; best = s; }
  }
  return best;
}

// Moves start/end to the nearest transcript segment boundary within `maxShift` seconds so clips don't cut
// mid-sentence, keeping the length within [minLen, maxLen] and the media bounds.
export function snapToSentences(start, end, segments, { maxShift = 4, minLen = 15, maxLen = 90, total = Infinity, pad = 0.3 } = {}) {
  const nearest = (target, points) => points.filter(p => Math.abs(p - target) <= maxShift).sort((a, b) => Math.abs(a - target) - Math.abs(b - target))[0];
  let s = nearest(start, segments.map(x => x.start)) ?? start;
  let e = nearest(end, segments.map(x => x.end));
  e = e === undefined ? end : e + pad;
  if (e - s < minLen || e - s > maxLen) { s = start; e = end; }
  s = Math.max(0, s); e = Math.min(total, e);
  return { start: Math.round(s * 100) / 100, end: Math.round(e * 100) / 100 };
}
