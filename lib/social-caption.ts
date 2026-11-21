import { z } from "zod/v4";
import { localDrafts } from "./local-captions.mjs";
export const captionRequest = z.object({
  topic: z.string().trim().max(3000).default(""), clipId: z.string().uuid().optional(),
  platform: z.enum(["Instagram", "TikTok", "YouTube", "Facebook", "LinkedIn", "X"]),
  tone: z.enum(["Casual", "Funny", "Professional", "Inspirational", "Bold"]),
  length: z.enum(["Short", "Medium", "Long"]), emojis: z.boolean(), hashtags: z.boolean(),
}).refine(input => !!input.clipId || input.topic.length >= 10);
export type CaptionRequest = z.infer<typeof captionRequest>;
export const captionLimit = (input: Pick<CaptionRequest, "platform" | "length">) => Math.min(({ Short: 240, Medium: 700, Long: 1400 })[input.length], input.platform === "X" ? 280 : Infinity);
export const socialCaptionsAvailable = (_env?: unknown) => true;
export function generateSocialCaptions(_env: unknown, input: CaptionRequest, context: { text?: string; streamer?: string } = {}) {
  return localDrafts({ ...input, text: context.text ?? input.topic, streamer: context.streamer ?? "" });
}
