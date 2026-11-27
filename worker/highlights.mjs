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
// `chatWeight` (0..1, even at 0.5): how much chat counts against loudness; learned per streamer from views.
export function pickWindow({ energy, chat = [], duration, from = 0, to = energy.length, lag = 4, chatWeight = 0.5 }) {
  const e = normalised(energy), c = normalised(chat), useChat = c.some(v => v > 0);
  const score = i => (e[i] ?? 0) * (useChat ? 1 - chatWeight : 1) + (useChat ? (c[i + lag] ?? 0) * chatWeight : 0);
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

// The first "!clip" command after `sinceMs` that should make a clip, or null. "mods": the streamer, a moderator
// or a VIP typed it. "everyone": that, or `crowd` different viewers typed it within `windowMs` (so one viewer
// can't spam clips). "off": never. `commands` are { t, by, mod } in time order.
export function commandTrigger(commands, { sinceMs, who = "mods", crowd = 3, windowMs = 30_000 }) {
  if (who === "off") return null;
  const fresh = commands.filter(c => c.t > sinceMs);
  for (let i = 0; i < fresh.length; i++) {
    const c = fresh[i];
    if (c.mod) return { atMs: c.t, by: c.by };
    if (who !== "everyone") continue;
    const viewers = new Set(fresh.slice(0, i + 1).filter(x => x.t > c.t - windowMs).map(x => x.by));
    if (viewers.size >= crowd) return { atMs: c.t, by: viewers.size + " viewers" };
  }
  return null;
}

// Up to `count` distinct candidate starts in [from, to - duration], best loudness-and-chat score first (the same
// score as pickWindow), each at least `gap` seconds from the others. `score` is relative to the best (1).
export function candidateWindows({ energy, chat = [], duration, from = 0, to = energy.length, lag = 4, count = 4, gap = Math.max(5, Math.round(duration / 2)), chatWeight = 0.5 }) {
  const e = normalised(energy), c = normalised(chat), useChat = c.some(v => v > 0);
  const score = i => (e[i] ?? 0) * (useChat ? 1 - chatWeight : 1) + (useChat ? (c[i + lag] ?? 0) * chatWeight : 0);
  const last = Math.max(from, Math.min(to, energy.length) - duration), all = [];
  for (let s = from; s <= last; s++) { let total = 0; for (let i = s; i < s + duration; i++) total += score(i); all.push({ start: s, total }); }
  all.sort((a, b) => b.total - a.total || a.start - b.start);
  const picked = [];
  for (const w of all) { if (picked.length >= count) break; if (picked.every(p => Math.abs(p.start - w.start) >= gap)) picked.push(w); }
  const top = picked[0]?.total || 1;
  return picked.map(p => ({ start: p.start, score: top > 0 ? p.total / top : 0 }));
}

// The candidate to clip: loudness and chat (`score`, 0..1) weighed against how good the language model rated what was
// said (`ratings`, 0..10 each, null when it couldn't rate). `weight` is how much the rating counts.
export function chooseMoment(candidates, ratings, weight = 0.6) {
  if (!candidates.length) return null;
  if (!Array.isArray(ratings) || ratings.length !== candidates.length) return candidates[0];
  let best = candidates[0], bestScore = -Infinity;
  candidates.forEach((c, i) => {
    const r = Number.isFinite(ratings[i]) ? Math.max(0, Math.min(10, ratings[i])) / 10 : null;
    const total = r === null ? c.score * (1 - weight) : c.score * (1 - weight) + r * weight;
    if (total > bestScore) { bestScore = total; best = { ...c, rating: ratings[i] }; }
  });
  return best;
}
