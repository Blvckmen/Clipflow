// Decides what an account does with its next queued post: post it, send it to TikTok drafts, or wait (and until
// when). Pure, so the rules can be tested on their own; the publisher gathers the counts and acts on the answer.
//
// The rules, in order:
//  - The account's own daily limit (or the workspace's) counts everything sent in the last 24 hours, drafts too.
//  - A minimum gap between posts spreads them through the day.
//  - TikTok takes about 15 videos per account per rolling day from apps, and drafts count towards that: a draft
//    is an upload too (seen on a live account: 15 drafts in a day, then the next ones held). Drafts don't add room.
//  - Once a limit is reached (the account's own, or TikTok's 15), an account set to hold (holdWhenFull) holds the post
//    for the owner's review ("hold") rather than letting it wait its turn, unless the owner queued it themselves:
//    then it waits for room like any other.

export const TIKTOK_DAILY = 15;
const DAY = 24 * 3600_000;

/**
 * @param {{ platform: string, wantsDraft: boolean, holdWhenFull?: boolean, queuedByHand?: boolean, limit: number, gapMinutes: number, directToday: number,
 *   draftsToday: number, lastSentAt: number | null, oldestSentAt: number | null, now: number }} s
 * @returns {{ action: "post" | "draft" | "wait" | "hold", until?: number, reason?: string }}
 */
export function planNext(s) {
  const sent = s.directToday + s.draftsToday, hold = !!s.holdWhenFull && !s.queuedByHand;
  if (sent >= s.limit && hold) return { action: "hold", reason: "daily limit of " + s.limit + " reached" };
  if (sent >= s.limit) return { action: "wait", until: s.oldestSentAt === null ? undefined : s.oldestSentAt + DAY, reason: "daily limit of " + s.limit + " reached" };
  if (s.gapMinutes > 0 && s.lastSentAt !== null && s.now - s.lastSentAt < s.gapMinutes * 60_000)
    return { action: "wait", until: s.lastSentAt + s.gapMinutes * 60_000, reason: "spacing posts " + s.gapMinutes + " minutes apart" };
  if (s.platform !== "tiktok") return { action: "post" };
  if (sent >= TIKTOK_DAILY && hold) return { action: "hold", reason: "TikTok's " + TIKTOK_DAILY + " videos a day from apps (drafts included) are used up" };
  if (sent >= TIKTOK_DAILY) return { action: "wait", until: s.oldestSentAt === null ? undefined : s.oldestSentAt + DAY, reason: "TikTok's " + TIKTOK_DAILY + " videos a day from apps (drafts included) are used up" };
  return { action: s.wantsDraft ? "draft" : "post" };
}

// TikTok refusals that mean "not now" rather than "never": the drafts inbox is full, or too many posts today.
// Matched on TikTok's error codes, which Zernio passes through in its messages.
export function tiktokBusy(message) {
  const m = String(message ?? "");
  if (/too_many_pending_share|pending shares?/i.test(m)) return "drafts";
  if (/too_many_posts|spam_risk/i.test(m)) return "posts";
  return null;
}
