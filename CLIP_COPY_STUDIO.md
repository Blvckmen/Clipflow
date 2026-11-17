# ClipFlow AI Copy Studio

## What's new
- Visit **/studio** or use **AI copy** on a clip in the library.
- The clipping worker reuses its Whisper word transcript and attaches text to clip reports. It does **not** make an additional transcription request.
- Transcript, generated options, selected hook, selected caption and approval state persist per clip in D1.
- Editing copy changes it back to draft. AI runs only after pressing Generate, which helps manage usage costs.
- Only explicitly approved **Instagram** copy is applied by ClipFlow's current publisher. Other social platforms can use the copy buttons while integrations are developed.
- Hooks are editable text, **not yet rendered into exported videos**. Older clips can have transcripts pasted manually.

## Required deployment steps
1. Run D1 migration `drizzle/0007_clip_copy_studio.sql` on the relevant database, after the existing migrations.
2. Configure `OPENAI_API_KEY` as a **Cloudflare Worker secret**, never in the browser or Git repository. Optional: `OPENAI_MODEL` (default `gpt-4o-mini`).
3. Deploy your updated application and updated clip worker. The older worker still uploads clips, but does not provide transcript text for this feature.
4. Check signed-in access to `/studio`, generate from a real transcript, save and approve. Test Instagram copy use on a private test account before enabling automated publishing.

## Important considerations
- Transcript text is sent to the configured AI provider when you click Generate; verify you have permission to process the streamed content.
- The AI may make mistakes; review generated claims and avoid deceptive hooks.
- Approving copy does not approve the underlying clip; the existing clip review gate still applies.
- The current schema stores one selected platform draft per clip, not multiple platform drafts simultaneously.
- Clips already queued for publishing will use the approved Instagram caption only if approved before that post is processed.
- No automatic AI calls, automatic hook overlays or performance-based optimisation are included in this initial implementation.
