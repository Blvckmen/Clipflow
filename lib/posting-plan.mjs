// Decides what an account does with its next queued post: post it, send it to TikTok drafts, or wait (and until
// when). Pure, so the rules can be tested on their own; the publisher gathers the counts and acts on the answer.
//
// The rules, in order:
//  - The account's own daily limit (or the workspace's) counts everything sent in the last 24 hours, drafts too.
//  - A minimum gap between posts spreads them through the day.
//  - TikTok takes about 15 direct posts per account per rolling day through its API. With overflow on, the next
//    ones go to the account's TikTok drafts instead, up to about 5 a day; the owner finishes those in the app.
//  - An account set to always use drafts only has the drafts allowance.

export const TIKTOK_DIRECT_DAILY = 15, TIKTOK_DRAFTS_DAILY = 5;
const DAY = 24 * 3600_000;

/**
 * @param {{ platform: string, wantsDraft: boolean, overflow: boolean, limit: number, gapMinutes: number,
 *   directToday: number, draftsToday: number, lastSentAt: number | null, oldestDirectAt: number | null,
 *   oldestDraftAt: number | null, now: number }} s
 * @returns {{ action: "post" | "draft" | "wait", until?: number, reason?: string }}
 */
export function planNext(s) {
  const sent = s.directToday + s.draftsToday;
  if (sent >= s.limit) return { action: "wait", reason: "daily limit of " + s.limit + " reached" };
  if (s.gapMinutes > 0 && s.lastSentAt !== null && s.now - s.lastSentAt < s.gapMinutes * 60_000)
    return { action: "wait", until: s.lastSentAt + s.gapMinutes * 60_000, reason: "spacing posts " + s.gapMinutes + " minutes apart" };
  if (s.platform !== "tiktok") return { action: "post" };
  const draftRoom = s.draftsToday < TIKTOK_DRAFTS_DAILY;
  const draftsFree = s.oldestDraftAt === null ? undefined : s.oldestDraftAt + DAY;
  if (s.wantsDraft) return draftRoom ? { action: "draft" } : { action: "wait", until: draftsFree, reason: "TikTok's drafts allowance (" + TIKTOK_DRAFTS_DAILY + " a day) is used up" };
  if (s.directToday < TIKTOK_DIRECT_DAILY) return { action: "post" };
  if (s.overflow && draftRoom) return { action: "draft" };
  const directFree = s.oldestDirectAt === null ? undefined : s.oldestDirectAt + DAY;
  return { action: "wait", until: directFree, reason: "TikTok's " + TIKTOK_DIRECT_DAILY + " direct posts a day are used up" + (s.overflow ? " and so are its " + TIKTOK_DRAFTS_DAILY + " drafts" : "") };
}

// TikTok refusals that mean "not now" rather than "never": the drafts inbox is full, or too many posts today.
// Matched on TikTok's error codes, which Zernio passes through in its messages.
export function tiktokBusy(message) {
  const m = String(message ?? "");
  if (/too_many_pending_share|pending shares?/i.test(m)) return "drafts";
  if (/too_many_posts|spam_risk/i.test(m)) return "posts";
  return null;
}
