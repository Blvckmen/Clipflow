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
export const youtubeVisibility = { public: "Public", unlisted: "Unlisted", private: "Private" } as const;

const keys = <T extends object>(o: T) => Object.keys(o) as [keyof T & string, ...(keyof T & string)[]];
export const optionsSchema = z.object({
  tiktokMode: z.enum(keys(tiktokModes)).optional(),
  tiktokPrivacy: z.enum(keys(tiktokPrivacy)).optional(),
  allowComments: z.boolean().optional(),
  youtubeVisibility: z.enum(keys(youtubeVisibility)).optional(),
}).strict();
export type AccountOptions = Required<z.infer<typeof optionsSchema>>;
export const defaultOptions: AccountOptions = { tiktokMode: "reviewed", tiktokPrivacy: "PUBLIC_TO_EVERYONE", allowComments: true, youtubeVisibility: "public" };

// Stored options merged over the defaults; anything unreadable falls back to them.
export function readOptions(json: string | null | undefined): AccountOptions {
  try { return { ...defaultOptions, ...optionsSchema.parse(JSON.parse(json ?? "{}")) }; } catch { return { ...defaultOptions }; }
}

// TikTok wants the creator to have seen and agreed to each post. "reviewed" (the default) treats approving a clip in
// review as that; automatically approved clips go to drafts to finish in the TikTok app.
export function tiktokSettings(options: AccountOptions, reviewed: boolean) {
  const direct = options.tiktokMode === "direct" || (options.tiktokMode === "reviewed" && reviewed);
  if (!direct) return { draft: true };
  return { privacyLevel: options.tiktokPrivacy, allowComment: options.allowComments, allowDuet: true, allowStitch: true, commercialContentType: "none", contentPreviewConfirmed: true, expressConsentGiven: true };
}
