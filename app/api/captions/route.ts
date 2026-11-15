
import { env } from "cloudflare:workers";
import { currentUser } from "../../auth";
import { captionRequest, generateSocialCaptions } from "../../../lib/social-caption";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  if (!await currentUser()) return Response.json({ error: "Sign in to generate captions." }, { status: 401 });
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return Response.json({ error: "Request origin rejected." }, { status: 403 });
  let input;
  try { input = captionRequest.parse(await request.json()); }
  catch { return Response.json({ error: "Describe your post in 10–3,000 characters and check your options." }, { status: 400 }); }
  if (!env.OPENAI_API_KEY?.trim()) return Response.json({ error: "AI caption generation isn't configured yet. The site owner needs to add OPENAI_API_KEY." }, { status: 409 });
  try { return Response.json(await generateSocialCaptions(env, input), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) {
    const message = error instanceof Error ? error.message : "Couldn't generate captions. Please try again.";
    return Response.json({ error: message }, { status: 502 });
  }
}
