// Transcript-based captions composed locally without a hosted AI service.
import { keywordTags, selectExcerpt, shorten, transcriptText } from "./local-captions.mjs";
type Env = Cloudflare.Env;
const BATCH_PER_RUN = 5;
const ADVANCE_WINDOW_MS = 48 * 3600_000;
export type CaptionParts = { title: string; body: string; hashtags: string[] };
// Keep the existing API field name for older clients; generation is always available.
export function aiCaptionsAvailable(_env?: unknown) { return true; }
export function composeCaption(parts: CaptionParts) {
  return [parts.title, parts.body, parts.hashtags.join(" ")].filter(Boolean).join("\n\n").slice(0, 2200);
}
export type ClipFacts = { streamer: string; platform: string; streamTitle: string | null; reason: string | null; words: [number, number, string][]; trim: { start: number; end: number } | null; notes: string };
export const spokenText = transcriptText;
export async function writeCaption(_env: Env, facts: ClipFacts): Promise<CaptionParts> {
  const text = spokenText(facts.words, facts.trim);
  if (!text) throw new Error("No transcript is available for the saved trim. Type your own post text or use the fallback.");
  const extras = facts.notes.match(/#[\p{L}\p{N}_]+/gu) ?? [];
  return { title: selectExcerpt(text, 90), body: "Clip from " + shorten(facts.streamer, 60) + " on " + shorten(facts.platform, 30) + ".",
    hashtags: keywordTags(text, [facts.streamer, facts.platform, ...extras], 6) };
}

export type CaptionRow = { id: string; owner: string; streamer: string | null; platform: string | null; live_title: string | null; reason: string | null; transcript: string | null; edit: string | null; caption_notes: string | null; post_caption: string | null; edit_rev: number };
const parse = <T,>(json: string | null): T | null => { try { return json ? JSON.parse(json) as T : null; } catch { return null; } };

// Read the corrected words and saved trim used to render this clip.
export function factsFromRow(row: CaptionRow): ClipFacts {
  const edit = parse<{ trim?: { start: number; end: number }; words?: [number, number, string][] }>(row.edit);
  return { streamer: row.streamer ?? "a streamer", platform: row.platform ?? "a stream", streamTitle: row.live_title, reason: row.reason,
    words: edit?.words ?? parse<[number, number, string][]>(row.transcript) ?? [], trim: edit?.trim ?? null, notes: row.caption_notes ?? "" };
}
export async function captionClip(env: Env, row: CaptionRow, replace = false): Promise<string | null> {
  const facts = factsFromRow(row);
  if (!spokenText(facts.words, facts.trim)) return null;
  const text = composeCaption(await writeCaption(env, facts));
  // A concurrent manual save or trim change always wins.
  const saved = await env.DB!.prepare("UPDATE clips SET post_caption=?,caption_source='local',caption_error=NULL,caption_tries=0 WHERE id=? AND owner=? AND edit_rev=? AND post_caption IS ?" + (replace ? "" : " AND coalesce(caption_source,'')!='edited'"))
    .bind(text, row.id, row.owner, row.edit_rev, row.post_caption).run();
  if (saved.meta.changes) return text;
  if (replace) throw new Error("The clip or its post text changed while writing. Reopen it and try again.");
  const latest = await env.DB!.prepare("SELECT post_caption FROM clips WHERE id=? AND owner=?").bind(row.id, row.owner).first<{post_caption:string|null}>();
  return latest?.post_caption ?? null;
}

export const CLIP_FACTS_SQL = "SELECT c.id,c.owner,c.reason,c.transcript,c.edit,c.post_caption,c.edit_rev,s.name AS streamer,s.platform,s.live_title,p.caption_notes FROM clips c LEFT JOIN streamers s ON s.id=c.streamer_id AND s.owner=c.owner LEFT JOIN preferences p ON p.owner=c.owner";

// Runs with the publisher: writes captions for a few recent clips that don't have one, so they can be read and
// edited before they post. A clip that can't get one (no speech in its trim) is set aside (caption_tries reaches
// MAX_TRIES) so it isn't picked again every minute, holding up the clips behind it; saving a new edit resets it.
// Only clips still waiting are read, through the partial index clips_caption_due.
const MAX_TRIES = 3;
export async function fillCaptions(env: Env, now = Date.now()) {
  const db = env.DB;
  if (!db) return;
  const since = new Date(now - ADVANCE_WINDOW_MS).toISOString();
  const { results } = await db.prepare(CLIP_FACTS_SQL.replace("FROM clips c", "FROM clips c INDEXED BY clips_caption_due") + " WHERE c.post_caption IS NULL AND c.caption_tries<" + MAX_TRIES + " AND c.transcript IS NOT NULL AND c.transcript!='[]' AND c.review!='rejected' AND c.created_at>=? AND coalesce(p.ai_captions,1)=1 ORDER BY c.created_at DESC LIMIT ?").bind(since, BATCH_PER_RUN).all<CaptionRow>();
  const setAside = (row: CaptionRow, tries: string, error: string) => db.prepare("UPDATE clips SET caption_tries=" + tries + ",caption_error=? WHERE id=? AND edit_rev=? AND post_caption IS NULL").bind(error.slice(0, 300), row.id, row.edit_rev).run();
  for (const row of results) {
    const facts = factsFromRow(row);
    if (!spokenText(facts.words, facts.trim)) { await setAside(row, String(MAX_TRIES), "Nothing is said in this clip's trim, so no post text was written. Write your own, or the fallback post text is used."); continue; }
    try { await captionClip(env, row); }
    catch (error) { await setAside(row, "caption_tries+1", "Couldn't write post text: " + (error as Error).message); }
  }
}

// The text to post: the stored caption, else a freshly written one, else null (the caller uses the template).
export async function captionForPost(env: Env, clipId: string): Promise<string | null> {
  const row = await env.DB!.prepare(CLIP_FACTS_SQL + " WHERE c.id=?").bind(clipId).first<CaptionRow>();
  const full = await env.DB!.prepare("SELECT c.post_caption,c.caption_tries,coalesce(p.ai_captions,1) AS ai FROM clips c LEFT JOIN preferences p ON p.owner=c.owner WHERE c.id=?").bind(clipId).first<{ post_caption: string | null; caption_tries: number; ai: number }>();
  if (!row || !full) return null;
  if (full.post_caption) return full.post_caption;
  if (!full.ai) return null;
  return captionClip(env, row);
}
