import { currentUser } from "../../auth";
import { database } from "../../../db/raw";
import { captionRequest, generateSocialCaptions } from "../../../lib/social-caption";
import { CLIP_FACTS_SQL, factsFromRow, spokenText, type CaptionRow } from "../../../lib/post-caption";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in to generate captions." }, { status: 401 });
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return Response.json({ error: "Request origin rejected." }, { status: 403 });
  let input;
  try { input = captionRequest.parse(await request.json()); }
  catch { return Response.json({ error: "Choose a clip or enter 10-3,000 characters, and check your options." }, { status: 400 }); }
  let context: { text?: string; streamer?: string } = {};
  if (input.clipId) {
    const row = await database().prepare(CLIP_FACTS_SQL + " WHERE c.id=? AND c.owner=?").bind(input.clipId, user.userId).first<CaptionRow>();
    if (!row) return Response.json({ error: "Clip not found." }, { status: 404 });
    const facts = factsFromRow(row), text = spokenText(facts.words, facts.trim);
    if (!text) return Response.json({ error: "This clip has no transcript in its saved trim. Enable Transcribe clips for new recordings, or choose Enter text to write a description." }, { status: 409 });
    context = { text, streamer: facts.streamer };
  }
  try { return Response.json(generateSocialCaptions({}, input, context), { headers: { "Cache-Control": "no-store" } }); }
  catch { return Response.json({error:"Please include some words in your description."},{status:400}); }
}
