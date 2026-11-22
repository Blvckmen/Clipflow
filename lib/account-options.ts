// Per-account posting options, set in the dashboard and stored as JSON in accounts.options.
import { z } from "zod";

export const tiktokModes = {
  reviewed: "Publish clips I approved myself; send the rest to drafts",
  direct: "Always publish directly",
  drafts: "Always send to my TikTok drafts",
} as const;
export const tiktokPrivacy = {
  PUBLIC_TO_EVERYONE: "Everyone",
  MUTUAL_FOLLOW_FRIENDS: "Friends",
  FOLLOWER_OF_CREATOR: "Followers",
  SELF_ONLY: "Only me",
} as const;
// What happens to new clips once this account has reached its daily limit (its own or the platform's, e.g. TikTok's
// 15): held for the owner to review (queue or skip each), or queued to go out as soon as there's room.
export const whenFullChoices = { review: "Hold new clips for my review", queue: "Queue them for when there's room" } as const;
export const youtubeVisibility = { public: "Public", unlisted: "Unlisted", private: "Private" } as const;
// When in the owner's day this account posts (see lib/posting-plan.mjs): any time, the hours its own posts got the
// most views, or a fixed window. Posts queued by hand go out at once regardless.
export const hoursChoices = { any: "Any time", best: "My best hours (learned from views)", window: "Between set hours" } as const;

const keys = <T extends object>(o: T) => Object.keys(o) as [keyof T & string, ...(keyof T & string)[]];
export const optionsSchema = z.object({
  tiktokMode: z.enum(keys(tiktokModes)).optional(),
  tiktokPrivacy: z.enum(keys(tiktokPrivacy)).optional(),
  allowComments: z.boolean().optional(),
  youtubeVisibility: z.enum(keys(youtubeVisibility)).optional(),
  // This account's own daily limit (null: the workspace's), and minutes to leave between its posts.
  dailyLimit: z.number().int().min(1).max(100).nullable().optional(),
  gapMinutes: z.number().int().min(0).max(720).optional(),
  whenFull: z.enum(keys(whenFullChoices)).optional(),
  hours: z.enum(keys(hoursChoices)).optional(),
  // The language this account posts in: clips get translated subtitles, hook and caption first (lib/languages.ts).
  subtitleLanguage: z.enum(["en", "es", "pt", "fr"]).optional(),
  // The window for hours "window", from hoursFrom up to hoursTo (0-23; it may wrap past midnight).
  hoursFrom: z.number().int().min(0).max(23).optional(),
  hoursTo: z.number().int().min(0).max(23).optional(),
  // The owner's time zone (IANA, from their browser) for the hours above.
  timeZone: z.string().max(64).regex(/^[A-Za-z0-9_+\-\/]+$/).optional(),
  // No longer used: drafts count towards TikTok's 15 a day as well, so overflowing to them adds nothing. Kept so
  // options saved with it still read.
  overflowToDrafts: z.boolean().optional(),
}).strict();
export type AccountOptions = Required<z.infer<typeof optionsSchema>>;
export const defaultOptions: AccountOptions = { tiktokMode: "reviewed", tiktokPrivacy: "PUBLIC_TO_EVERYONE", allowComments: true, youtubeVisibility: "public", dailyLimit: null, gapMinutes: 0, whenFull: "review", overflowToDrafts: true, hours: "any", hoursFrom: 17, hoursTo: 23, timeZone: "UTC", subtitleLanguage: "en" };
export const gapChoices = { 0: "Post as soon as possible", 15: "At least 15 minutes apart", 30: "At least 30 minutes apart", 60: "At least 1 hour apart", 120: "At least 2 hours apart", 180: "At least 3 hours apart" } as const;

// Stored options merged over the defaults; anything unreadable falls back to them.
export function readOptions(json: string | null | undefined): AccountOptions {
  try { return { ...defaultOptions, ...optionsSchema.parse(JSON.parse(json ?? "{}")) }; } catch { return { ...defaultOptions }; }
}

// Whether this account's TikTok mode sends a clip to drafts rather than publishing it.
export function wantsDraft(options: AccountOptions, reviewed: boolean) {
  return options.tiktokMode === "drafts" || (options.tiktokMode === "reviewed" && !reviewed);
}

// TikTok wants the creator to have seen and agreed to each post. "reviewed" (the default) treats approving a clip in
// review as that; automatically approved clips go to drafts to finish in the TikTok app.
export function tiktokSettings(options: AccountOptions, reviewed: boolean) {
  const direct = options.tiktokMode === "direct" || (options.tiktokMode === "reviewed" && reviewed);
  if (!direct) return { draft: true };
  return { privacyLevel: options.tiktokPrivacy, allowComment: options.allowComments, allowDuet: true, allowStitch: true, commercialContentType: "none", contentPreviewConfirmed: true, expressConsentGiven: true };
}
