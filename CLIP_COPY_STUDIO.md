# ClipFlow AI Copy Studio

## What's new
- Visit **/studio** or use **AI copy** on a clip in the library.
- The clipping worker reuses its Whisper word transcript and attaches text to clip reports. It does **not** make an additional transcription request.
- Transcript, generated options, selected hook, selected caption and approval state persist per clip in D1.
- Editing copy changes it back to draft. AI runs only after pressing Generate, which helps manage usage costs.
- Only explicitly approved **Instagram** copy is applied by ClipFlow's current publisher. Other social platforms can use the copy buttons while integrations are developed.
- Hooks are editable text, **not yet rendered into exported videos**. Older clips can have transcripts pasted manually.

## Required deployment steps
1. Run D1 migrations `drizzle/0007_clip_copy_studio.sql` and `drizzle/0008_auto_clip_copy.sql` on the relevant database, after the existing migrations.
2. **Default: Cloudflare Workers AI.** The Vite and Cloudflare deployment configuration provisions an `AI` binding. No `OPENAI_API_KEY` is required. By default, the engine uses `@cf/meta/llama-3.1-8b-instruct-fast`.
3. Optional: choose `AI_PROVIDER=openai` and configure `OPENAI_API_KEY` as a Worker secret (never commit it), optionally setting `OPENAI_MODEL`. OpenAI API usage is billed separately. The deployment script forwards the secret if provided in ignored `.env` for an explicitly selected OpenAI provider. There is no silent fallback to paid OpenAI when Cloudflare AI fails.
4. Deploy your updated application and updated clip worker. The older worker still uploads clips, but does not provide transcript text for this feature.
5. Check signed-in access to `/studio`, generate from a real transcript, save and approve. Test Instagram copy use on a private test account before enabling automated publishing.

## Important considerations
- Transcript text is sent to the configured AI provider when you click Generate or when automatic background generation processes a new clip; verify you have permission to process the streamed content.
- The AI may make mistakes; review generated claims and avoid deceptive hooks.
- Approving copy does not approve the underlying clip; the existing clip review gate still applies.
- The current schema stores one selected platform draft per clip, not multiple platform drafts simultaneously.
- Clips already queued for publishing will use the approved Instagram caption only if approved before that post is processed.
- Automatic background copy generation runs from the existing once-a-minute cron. It processes at most three transcript-ready clips per run, retries a failed generation up to three times, and always leaves results as drafts.
- Automatic hook overlays and performance-based optimisation are not included yet.

## AI provider settings

| Provider | Configuration | API key |
| --- | --- | --- |
| Cloudflare Workers AI (default) | `AI` binding in worker deployment | No OpenAI key needed |
| OpenAI (opt-in) | `AI_PROVIDER=openai` and `OPENAI_API_KEY` | OpenAI API billing applies |

Cloudflare Workers AI usage counts against your Cloudflare account allocation and potential overage charges. The default requires the `AI` binding on the deployed Worker; creating it in the application code alone is not sufficient. Before deploying from a different pipeline, ensure the Worker has `ai: {binding: "AI"}`. Provider selection is at deployment configuration level, not an end-user dashboard toggle.
