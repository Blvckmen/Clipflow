# Deploying Clipflow to your Cloudflare account

`npm run deploy` builds Clipflow and deploys it to your own Cloudflare account as a
Worker, with sign-in handled by Cloudflare Access. It is safe to re-run: it reuses the
database, storage bucket and Access applications it created before, and applies only
new database migrations.

## One-time setup

1. **Cloudflare account** — sign up at dash.cloudflare.com (free).
2. **workers.dev subdomain** — open **Workers & Pages** once and accept the suggested
   subdomain. The site will live at `https://clipflow.<subdomain>.workers.dev`.
3. **Zero Trust team** — open **Zero Trust** once, choose a team name and the **Free**
   plan (up to 50 users). This is what provides the sign-in page.
4. **R2 (optional)** — open **R2** and enable it to store clip files in the dashboard so
   they can be played and downloaded there. Without it, clips stay on the worker machine.
5. **API token** — **My Profile → API Tokens → Create Token → Custom token** with:
   - Account · Workers Scripts · Edit
   - Account · D1 · Edit
   - Account · Workers R2 Storage · Edit
   - Account · Access: Apps and Policies · Edit
   - Account · Access: Organizations, Identity Providers, and Groups · Read
   - Account · Account Settings · Read
6. **`.env`** in the project root (already git-ignored — never commit it or paste the token anywhere):

   ```ini
   CLOUDFLARE_API_TOKEN=...
   CLIPFLOW_ACCESS_EMAILS=you@example.com
   # Optional:
   # CLOUDFLARE_ACCOUNT_ID=...          only needed if the token can see several accounts
   # CLIPFLOW_WORKER_NAME=clipflow
   # CLIPFLOW_HOSTNAME=clips.example.com  a custom domain on a zone in this account
   ```

## Deploy

```sh
npm run deploy:check   # read-only: confirms the token and every prerequisite
npm run deploy         # build, create what's missing, migrate, deploy, smoke-test
```

The final smoke test confirms that the dashboard redirects to the Access sign-in page and
that `/api/worker/*` answers the worker directly (it uses its own bearer token, so it is
exempt from Access). Then sign in, open **Connect worker**, create a token and point the
worker at the site (see `worker/README.md`).

## Publishing to TikTok, Instagram and YouTube (Zernio)

The simple way to publish. [Zernio](https://zernio.com) already has approved apps for each platform, so there is
no Meta app, Google audit or TikTok review to go through.

Everything is set up in the dashboard, under **Connections → Social accounts**; no code change or redeploy:

1. Create a Zernio account and copy its API key (zernio.com → Settings → API keys). Paste it into **Zernio API
   key** and save. Clipflow checks it with Zernio and stores it encrypted with `TOKEN_KEY`; it is never shown again.
2. Press a platform (TikTok, Instagram, YouTube, Facebook, X, Threads) to connect an account with that platform's
   own sign-in. You come back to Clipflow with the account added. Accounts already connected on zernio.com are
   picked up when the key is saved, or with **Refresh**.
3. The first accounts post every streamer's clips; change that per streamer under **Streamers → Posts to**.
   **Options** on a TikTok or YouTube account sets how it posts (below). **Disconnect** removes it on Zernio too.

Optionally, `ZERNIO_API_KEY=sk_...` in `.env` (uploaded by `npm run deploy`) is a site-wide key for workspaces
that have not entered their own.

## Viewers' Twitch clips

To import the clips viewers make on Twitch, the site needs one Twitch app for everyone: register one at
dev.twitch.tv (no OAuth redirect is used; any URL works), then put `TWITCH_CLIENT_ID=...` and
`TWITCH_CLIENT_SECRET=...` in `.env`. `npm run deploy` sends the ID as a setting and the secret as a secret. Workers
then look clips up through `/api/worker/twitch` (worker token only; users, clips and videos lookups only), so no
customer creates a Twitch app. A worker with its own `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET` in `worker/.env`
keeps using those.

Each approved clip is sent to Zernio as a signed video link (valid 24 hours) and published right away. Retries,
the daily limit and pausing work as below. YouTube gets the caption's first line as its title and the account's
visibility (public by default). TikTok asks that the creator has seen each post, so by default clips you approve
yourself in review mode are published and clips approved automatically go to your TikTok drafts; a TikTok
account's options can instead always publish or always use drafts, and set who can watch and comments. Test locally against a fake Zernio with
`npm run build` then `npm run test:zernio`.

## Local transcript-based post captions

Post captions are composed from the worker's saved Whisper transcript using local code. No OpenAI or Anthropic key, model service, or per-caption API fee is required. Whisper still needs to be installed on the worker and downloads its speech model on first use.

Enable **Transcribe clips** in Settings. Under Publishing preferences, **Create post captions from transcripts** chooses a spoken excerpt, credits the streamer and adds keyword hashtags. Only words inside the saved trim are used, including saved corrections. Extra hashtags accepts #tags, not natural-language AI instructions. With no usable transcript, the configured fallback caption is used.

Under **Clip library > Edit > Post caption**, generate a caption from the saved transcript or type your own. Manual captions are preserved. Saving a clip edit invalidates a locally generated caption so it is regenerated for the new trim. Previously saved AI captions remain unless explicitly replaced.

## Instagram publishing directly (optional, instead of Zernio)

Clipflow posts approved clips as Reels to **your own** Instagram professional account. Meta's docs say an
app that only serves accounts you own or manage needs Standard Access, so no App Review is required.

1. Make the Instagram account **Professional** (Business or Creator) in the Instagram app's settings.
2. At developers.facebook.com create an app with the **Instagram API with Instagram Login** use case.
3. Under its Instagram API setup, copy the **Instagram app ID** and **Instagram app secret** (not the Meta app ID).
4. Under Business login settings, add the OAuth redirect URI
   `https://<your site>/api/connections/instagram/callback`.
5. Under App roles, add your Instagram account as an **Instagram tester**, then accept the invite in Instagram
   (Settings → Apps and websites → Tester invites).
6. Add to `.env`, then `npm run deploy`:

   ```ini
   INSTAGRAM_APP_ID=...
   INSTAGRAM_APP_SECRET=...
   ```
7. In the dashboard: **Connections → Connect Instagram**, then **Settings → Preferred destinations → Instagram**,
   and adjust the post caption if you like.

The deploy script also generates `TOKEN_KEY` (encrypts stored Instagram tokens) and `MEDIA_KEY` (signs the
temporary video links Instagram downloads from) and saves them to `.env`. Keep them: changing `TOKEN_KEY`
makes stored tokens unreadable, so accounts would need reconnecting.

A once-a-minute cron trigger publishes. Only clips approved after the account was connected are posted, at
most the daily limit per day and within Instagram's own 24-hour limit; pausing or stopping automation pauses
publishing. Test the whole flow locally against a fake Instagram with `npm run build` then
`npm run test:publishing`.

## How sign-in works

The app reads `AUTH_MODE`:

- `sites` (default) — identity headers from Codex Sites hosting, and the local mock sign-in.
- `access` (set by the deploy script) — only a verified Cloudflare Access token
  (`Cf-Access-Jwt-Assertion`, checked against the team's signing keys and the application's
  audience tag). Sites headers are ignored in this mode because a client could send them itself.

Data is stored per Access user. A deployment on Cloudflare starts with an empty database;
it does not share data with a Codex Sites deployment.

## Social caption generator

Choose a recorded clip or enter a transcript/description to produce three template variations. Captions are built by the app without external AI requests. Tone, length, emoji and hashtag controls are supported; outputs are excerpts and templates, not creative AI rewrites. Generation and copying do not publish a post. Missing clip transcripts produce an explanation instead of fabricated content.

Drafts are temporary. Limits count Unicode code points: Short 240, Medium 700, Long 1,400, capped at 280 for X. Review Whisper transcription errors before sharing.
