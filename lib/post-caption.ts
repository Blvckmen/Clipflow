// Post captions written by Claude from what was said in the clip. A caption is three parts, joined for posting:
// a short title line (also used as the YouTube title), one or two sentences, and a few hashtags.
// Runs on the server with the site's ANTHROPIC_API_KEY; without one, posts fall back to the caption template.
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod/v4";

type Env = Cloudflare.Env;
export const MAX_CAPTION_TRIES = 2;
const BATCH_PER_RUN = 5;
// Only recent clips get captions written in advance; older ones are written when they are about to post.
const ADVANCE_WINDOW_MS = 48 * 3600_000;

const CaptionSchema = z.object({
  title: z.string().describe("A scroll-stopping first line, at most 90 characters. Used as the video title on YouTube."),
  body: z.string().describe("One or two short sentences about what happens in the clip, at most 280 characters."),
  hashtags: z.array(z.string()).describe("3 to 6 relevant hashtags, each starting with #, no spaces."),
});
export type CaptionParts = z.infer<typeof CaptionSchema>;

const SYSTEM = `You write the text that goes under a short-form video (Instagram Reels, TikTok, YouTube Shorts) cut from a livestream.

Work only from what you are given: the transcript of the clip, the streamer's name, the platform they stream on, the stream title, and why the moment was picked. Never invent events, names, scores, quotes or claims that the transcript doesn't support. If the transcript is empty or unclear, write something short that fits the streamer and stream title rather than guessing what happened.

Always credit the streamer by name in the title or body. Write like a fan clip account: punchy, plain, present tense, no clickbait lies. Avoid slurs and sexual content even if the transcript has them; you may allude to swearing without spelling it out. At most two emoji in total. Hashtags: include the streamer's name as a tag, the streaming platform, and a few broad discovery tags that fit the content.

The owner may add guidance of their own; follow it unless it conflicts with the rules above.`;

export function aiCaptionsAvailable(env: Env) { return !!env.ANTHROPIC_API_KEY; }

export function composeCaption(parts: CaptionParts) {
  const tags = [...new Set(parts.hashtags.map(t => "#" + t.replace(/^#+/, "").replace(/[^\p{L}\p{N}_]/gu, "")).filter(t => t.length > 1))].slice(0, 8);
  return [parts.title.trim().slice(0, 100), parts.body.trim().slice(0, 400), tags.join(" ")].filter(Boolean).join("\n\n").slice(0, 2200);
}

type ClipFacts = { streamer: string; platform: string; streamTitle: string | null; reason: string | null; words: [number, number, string][]; trim: { start: number; end: number } | null; notes: string };

// The transcript inside the published part of the clip, as plain text.
export function spokenText(words: [number, number, string][], trim: { start: number; end: number } | null) {
  return words.filter(([s, e, t]) => t && (!trim || (s >= trim.start - 0.05 && e <= trim.end + 0.05))).map(w => w[2]).join(" ").slice(0, 4000);
}

export async function writeCaption(env: Env, facts: ClipFacts): Promise<CaptionParts> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, ...(env.ANTHROPIC_BASE_URL && { baseURL: env.ANTHROPIC_BASE_URL }), maxRetries: 2, timeout: 60_000 });
  const spoken = spokenText(facts.words, facts.trim);
  const lines = [
    "Streamer: " + facts.streamer,
    "Streams on: " + facts.platform,
    "Stream title: " + (facts.streamTitle || "(unknown)"),
    "Why this moment was clipped: " + (facts.reason === "chat" ? "chat suddenly got much busier" : facts.reason === "audio" ? "it was the loudest moment" : "(unknown)"),
    "Transcript of the clip: " + (spoken ? "<transcript>" + spoken + "</transcript>" : "(no transcript available)"),
  ];
  if (facts.notes.trim()) lines.push("Owner's guidance: <guidance>" + facts.notes.trim().slice(0, 1000) + "</guidance>");
  const response = await client.beta.messages.parse({
    model: "claude-opus-5-5",
    max_tokens: 2000,
    // A short writing task: low effort keeps it fast and cheap.
    output_config: { effort: "low", format: betaZodOutputFormat(CaptionSchema) },
    // If the model declines (for example a transcript that trips a safety classifier), the API retries on a
    // fallback model chosen for that kind of refusal.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEM,
    messages: [{ role: "user", content: lines.join("\n") }],
  });
  if (response.stop_reason === "refusal") throw new Error("Claude declined to write a caption for this clip.");
  if (response.stop_reason === "max_tokens" || !response.parsed_output) throw new Error("Claude's caption came back incomplete.");
  return response.parsed_output;
}

type Row = { id: string; owner: string; streamer: string | null; platform: string | null; live_title: string | null; reason: string | null; transcript: string | null; edit: string | null; caption_notes: string | null };
const parse = <T,>(json: string | null): T | null => { try { return json ? JSON.parse(json) as T : null; } catch { return null; } };

// Writes and stores the caption for one clip. Returns the posting text, or null if it could not be written
// (the attempt and reason are recorded, and after MAX_CAPTION_TRIES the template is used).
export async function captionClip(env: Env, row: Row): Promise<string | null> {
  const db = env.DB!;
  const edit = parse<{ trim?: { start: number; end: number }; words?: [number, number, string][] }>(row.edit);
  try {
    const parts = await writeCaption(env, {
      streamer: row.streamer ?? "a streamer", platform: row.platform ?? "a stream", streamTitle: row.live_title, reason: row.reason,
      words: edit?.words ?? parse<[number, number, string][]>(row.transcript) ?? [], trim: edit?.trim ?? null, notes: row.caption_notes ?? "",
    });
    const text = composeCaption(parts);
    // Never overwrite a caption the owner typed meanwhile.
    await db.prepare("UPDATE clips SET post_caption=?,caption_source='ai',caption_error=NULL,caption_tries=caption_tries+1 WHERE id=? AND coalesce(caption_source,'')!='edited'").bind(text, row.id).run();
    return text;
  } catch (error) {
    const message = error instanceof Anthropic.AuthenticationError ? "The site's Anthropic API key was refused." : error instanceof Anthropic.RateLimitError ? "Claude is rate limited; will retry." : (error as Error).message;
    await db.prepare("UPDATE clips SET caption_error=?,caption_tries=caption_tries+1 WHERE id=?").bind(message.slice(0, 300), row.id).run();
    return null;
  }
}

export const CLIP_FACTS_SQL = "SELECT c.id,c.owner,c.reason,c.transcript,c.edit,s.name AS streamer,s.platform,s.live_title,p.caption_notes FROM clips c LEFT JOIN streamers s ON s.id=c.streamer_id AND s.owner=c.owner LEFT JOIN preferences p ON p.owner=c.owner";

// Runs with the publisher: writes captions for a few recent clips that don't have one, so they can be read and
// edited before they post.
export async function fillCaptions(env: Env, now = Date.now()) {
  if (!env.DB || !aiCaptionsAvailable(env)) return;
  const since = new Date(now - ADVANCE_WINDOW_MS).toISOString();
  const { results } = await env.DB.prepare(CLIP_FACTS_SQL + " WHERE c.post_caption IS NULL AND c.caption_tries<? AND c.review!='rejected' AND c.created_at>=? AND coalesce(p.ai_captions,1)=1 ORDER BY c.created_at DESC LIMIT ?").bind(MAX_CAPTION_TRIES, since, BATCH_PER_RUN).all<Row>();
  for (const row of results) await captionClip(env, row);
}

// The text to post: the stored caption, else a freshly written one, else null (the caller uses the template).
export async function captionForPost(env: Env, clipId: string): Promise<string | null> {
  const row = await env.DB!.prepare(CLIP_FACTS_SQL + " WHERE c.id=?").bind(clipId).first<Row>();
  const full = await env.DB!.prepare("SELECT c.post_caption,c.caption_tries,coalesce(p.ai_captions,1) AS ai FROM clips c LEFT JOIN preferences p ON p.owner=c.owner WHERE c.id=?").bind(clipId).first<{ post_caption: string | null; caption_tries: number; ai: number }>();
  if (!row || !full) return null;
  if (full.post_caption) return full.post_caption;
  if (!full.ai || !aiCaptionsAvailable(env) || full.caption_tries >= MAX_CAPTION_TRIES) return null;
  return captionClip(env, row);
}
