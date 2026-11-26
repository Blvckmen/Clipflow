// Learning from views: what kind of clip does best for each streamer, from posts the platforms have measured.
// Pure, so it can be tested; lib/analytics.ts gathers the rows and stores or shows the answers.
//
// A group's "typical views" is its median, so one viral post doesn't decide, and a finding is how many times more a
// group typically gets than the rest. Only clear differences
// with enough posts on both sides are reported.

export const MIN_POSTS = 10;      // measured posts a streamer needs before anything is concluded for them
const MIN_GROUP = 3, MIN_RATIO = 1.3;
export const CHAT_WEIGHT = { base: 0.5, min: 0.2, max: 0.8 };

const REASONS = { command: "!clip in chat", chat: "chat spikes", audio: "loud moments", best: "best of a recording", manual: "picked by hand", viewer: "viewers' Twitch clips", crowd: "moments viewers clipped live" };
const LENGTHS = [[0, 25, "under 25s"], [25, 40, "25-40s"], [40, 60, "40-60s"], [60, 1e9, "over 60s"]];

// A group's typical views: the median, so one viral post (or one flop) doesn't move it.
const typical = rows => { const v = rows.map(r => r.views).sort((a, b) => a - b), m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
const fmt = x => (x >= 10 ? Math.round(x) : Math.round(x * 10) / 10) + "x";

// The best group against everything else, when it is clearly better. groups: [label, rows][]
function bestOf(groups, all) {
  const scored = groups.filter(([, rows]) => rows.length >= MIN_GROUP && all.length - rows.length >= MIN_GROUP)
    .map(([label, rows]) => { const rest = all.filter(r => !rows.includes(r)); return { label, n: rows.length, ratio: (typical(rows) + 1) / (typical(rest) + 1), views: typical(rows) }; })
    .sort((a, b) => b.ratio - a.ratio);
  return scored[0] && scored[0].ratio >= MIN_RATIO ? scored[0] : null;
}

/**
 * Findings for one streamer's (or the whole workspace's) measured posts.
 * @param {{ reason: string|null, duration: number|null, hook: boolean, views: number }[]} posts
 * @returns {{ kind: "reason"|"length"|"hook", text: string, ratio: number, n: number }[]}
 */
export function findings(posts) {
  const rows = (posts ?? []).filter(p => Number.isFinite(p.views) && p.views >= 0);
  if (rows.length < MIN_POSTS) return [];
  const out = [];
  const byReason = bestOf(Object.entries(REASONS).map(([k, label]) => [label, rows.filter(r => r.reason === k)]), rows);
  if (byReason) out.push({ kind: "reason", text: "Clips from " + byReason.label + " get " + fmt(byReason.ratio) + " the views of the rest", ratio: byReason.ratio, n: byReason.n });
  const byLength = bestOf(LENGTHS.map(([a, b, label]) => [label, rows.filter(r => Number.isFinite(r.duration) && r.duration >= a && r.duration < b)]), rows.filter(r => Number.isFinite(r.duration)));
  if (byLength) out.push({ kind: "length", text: "Clips " + byLength.label + " long get " + fmt(byLength.ratio) + " the views of other lengths", ratio: byLength.ratio, n: byLength.n });
  const hooked = rows.filter(r => r.hook), bare = rows.filter(r => !r.hook);
  if (hooked.length >= MIN_GROUP && bare.length >= MIN_GROUP) {
    const ratio = (typical(hooked) + 1) / (typical(bare) + 1);
    if (ratio >= MIN_RATIO) out.push({ kind: "hook", text: "Clips with a hook title get " + fmt(ratio) + " the views of clips without one", ratio, n: hooked.length });
    else if (1 / ratio >= MIN_RATIO) out.push({ kind: "hook", text: "Clips without a hook title get " + fmt(1 / ratio) + " the views of clips with one", ratio: 1 / ratio, n: bare.length });
  }
  return out.sort((a, b) => b.ratio - a.ratio);
}

// ---- View profile, for the virality score (lib/virality.mjs learnedScore) ----
// Each post is measured against this streamer's typical views on the same platform (TikTok and YouTube numbers aren't
// comparable), as a ratio: 1 is typical, 2 is twice the usual. A kind of moment's "lift" is the median ratio of its
// posts. Stored in streamers.learned.views by lib/analytics.ts, rounded so it only changes when something does.
export const PROFILE_MIN = 5;
const round2 = x => Math.round(x * 100) / 100;

/** Typical views per platform for these posts (at least 3 on a platform, else the streamer's overall median). */
export function platformMedians(posts) {
  const rows = (posts ?? []).filter(p => Number.isFinite(p.views) && p.views >= 0);
  if (!rows.length) return { all: 0, platforms: {} };
  const platforms = {};
  for (const name of new Set(rows.map(r => r.platform).filter(Boolean))) { const g = rows.filter(r => r.platform === name); if (g.length >= MIN_GROUP) platforms[name] = Math.round(typical(g)); }
  return { all: Math.round(typical(rows)), platforms };
}

// A post's views against the streamer's typical views on that platform. Ten views are added to both sides so tiny
// numbers don't swing it: on an account that typically gets 0 views, 5 views is 1.5x, not 6x.
const SMOOTH = 10;
export const viewRatio = (views, platform, profile) => (views + SMOOTH) / ((profile.platforms?.[platform] ?? profile.median) + SMOOTH);

/**
 * One streamer's view profile from their measured posts. Null: fewer than PROFILE_MIN measured posts.
 * @param {{ reason: string|null, platform?: string, views: number }[]} posts
 * @returns {{ median: number, n: number, platforms: Record<string, number>, reasons: Record<string, { lift: number, n: number }> } | null}
 */
export function viewProfile(posts) {
  const rows = (posts ?? []).filter(p => Number.isFinite(p.views) && p.views >= 0);
  if (rows.length < PROFILE_MIN) return null;
  const { all, platforms } = platformMedians(rows), profile = { median: all, n: rows.length, platforms, reasons: {} };
  for (const k of Object.keys(REASONS)) {
    const ratios = rows.filter(r => r.reason === k).map(r => viewRatio(r.views, r.platform, profile)).sort((a, b) => a - b);
    if (ratios.length < MIN_GROUP) continue;
    const m = ratios.length >> 1, lift = ratios.length % 2 ? ratios[m] : (ratios[m - 1] + ratios[m]) / 2;
    profile.reasons[k] = { lift: round2(lift), n: ratios.length };
  }
  return profile;
}

/**
 * How much the worker should weigh chat against loudness when it picks a moment for this streamer (0.5 is even),
 * from how chat-spike clips did against loud-moment clips. Null: not enough of both to say.
 */
export function learnedChatWeight(posts) {
  const rows = (posts ?? []).filter(p => Number.isFinite(p.views) && p.views >= 0);
  const chat = rows.filter(r => r.reason === "chat" || r.reason === "command"), loud = rows.filter(r => r.reason === "audio");
  if (rows.length < MIN_POSTS || chat.length < MIN_GROUP || loud.length < MIN_GROUP) return null;
  const ratio = (typical(chat) + 1) / (typical(loud) + 1);
  // Twice the views moves the weight by 0.15, within CHAT_WEIGHT.min..max.
  const w = CHAT_WEIGHT.base + 0.15 * Math.log2(ratio);
  return Math.round(Math.min(CHAT_WEIGHT.max, Math.max(CHAT_WEIGHT.min, w)) * 100) / 100;
}
