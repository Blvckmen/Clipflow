// The virality score: one 0-100 number per clip for how likely it is to do well, so the best clips are reviewed and
// posted first. Made when the worker reports the clip, from what it knows about the moment:
//  - why it was clipped: someone typed !clip or a viewer clipped it on Twitch (people chose it) counts most, a chat
//    spike next, a moment picked from a recording, then a loud moment found by the every-few-minutes check;
//  - how far chat jumped above its usual rate (chatLift, the busiest 10 seconds against the window's typical 10);
//  - the local AI's 0-10 rating of what was said (rating);
//  - how far the loudness stood out (loudLift).
// Clips reported before scoring existed get a score from their reason alone.

const BASE = { command: 62, viewer: 60, chat: 50, manual: 48, best: 44, audio: 34 };

/**
 * @param {{ reason?: string | null, rating?: number | null, chatLift?: number | null, loudLift?: number | null }} clip
 * @returns {number} 1-99
 */
export function viralityScore({ reason, rating, chatLift, loudLift } = {}) {
  let score = BASE[reason ?? ""] ?? 40;
  // Chat: up to +22 for a spike of five times the usual rate or more.
  if (Number.isFinite(chatLift) && chatLift > 1) score += Math.min(22, (chatLift - 1) * 5.5);
  // The AI's rating: 5 of 10 is neutral, 10 adds 15, 0 takes 15 away.
  if (Number.isFinite(rating)) score += (Math.max(0, Math.min(10, rating)) - 5) * 3;
  // Loudness: up to +8 for a peak three times the window's typical level.
  if (Number.isFinite(loudLift) && loudLift > 1) score += Math.min(8, (loudLift - 1) * 4);
  return Math.max(1, Math.min(99, Math.round(score)));
}

/** A word for the score, for badges and screen readers. */
export function viralityLabel(score) {
  return score >= 75 ? "Hot" : score >= 55 ? "Promising" : score >= 40 ? "OK" : "Weak";
}
