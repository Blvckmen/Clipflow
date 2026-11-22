// When a live stream gets clipped. Triggers (chat spikes, "!clip") wait in a small queue instead of being dropped
// during a cool-down: ones close together become one clip, and ones inside a stretch already clipped are skipped.
// Between them the whole stream is covered: back-to-back windows that start where the last clip or check ended, so
// nothing is looked at twice or never (the AI rating then drops the dull ones; see processWindow's minRating).
// Pure; main.mjs keeps the state per session ({ queue, coveredUntil }) and acts on the answers.

export const MERGE_MS = 20_000;

/**
 * Adds a trigger ({ atMs, reason }) to `queue` unless it falls in what's already been clipped (before `coveredUntil`,
 * wall-clock ms) or within MERGE_MS of a queued one (merged into it: "!clip" names the clip over a chat spike).
 * @returns {"queued" | "merged" | "covered"}
 */
export function enqueueTrigger(queue, coveredUntil, trigger) {
  if (trigger.atMs <= coveredUntil) return "covered";
  const near = queue.find(q => Math.abs(q.atMs - trigger.atMs) < MERGE_MS);
  if (near) { if (trigger.reason === "command") near.reason = "command"; return "merged"; }
  queue.push({ atMs: trigger.atMs, reason: trigger.reason });
  queue.sort((a, b) => a.atMs - b.atMs);
  return "queued";
}

/**
 * The next stretch of the stream to check when nothing triggered: from where the last clip or check ended (or as far
 * back as the buffer goes) to `latest`, once it's at least `readyShare` of `lookbackMs` long. Null while it's too short,
 * or while `waiting` coverage checks are already queued (at most `maxWaiting`), so a slow PC isn't buried.
 * @returns {{ fromMs: number, toMs: number } | null}
 */
export function coverageWindow({ coveredUntil, latest, lookbackMs, readyShare = 0.8, waiting = 0, maxWaiting = 2 }) {
  if (waiting >= maxWaiting) return null;
  const fromMs = Math.max(coveredUntil, latest - lookbackMs);
  return latest - fromMs >= lookbackMs * readyShare ? { fromMs, toMs: latest } : null;
}

// Coverage checks stop once a streamer's clips today reach this share of the daily limit (COVERAGE_SHARE, 0.7), so
// the rest is kept for chat spikes, "!clip" and viewers' clips. Every check passed the AI rating (it rates nearly
// everything 7-8 of 10), so coverage alone used up the limit and stopped the recording mid-stream.
export const COVERAGE_SHARE = 0.7;
export function coverageRoom(countToday, dailyLimit, share = COVERAGE_SHARE) {
  const s = Number.isFinite(share) && share > 0 && share <= 1 ? share : COVERAGE_SHARE;
  return countToday < Math.max(1, Math.floor(dailyLimit * s));
}

/**
 * Which job the worker takes next (lowest first): moments people reacted to (chat spikes, "!clip", viewers' clips,
 * clips asked for by hand) and the owner's re-renders and translations, then coverage checks; a clip resumed after a
 * stop just after its fresh kind; highlight videos (long and never urgent) last. Coverage checks used to go first in
 * turn with everything else and kept the resumed chat-spike clips waiting until the next restart.
 */
export function jobRank(job) {
  if (job.kind === "highlight") return 4;
  const coverage = !job.kind && job.reason === "audio";
  return (coverage ? 2 : 0) + (job.resumed ? 1 : 0);
}
