# Clipflow implementation status

## Working scope

This is a private, persistent configuration dashboard. It saves multiple Twitch,
YouTube, and Kick channel records, enabled/paused/stopped preferences, clipping
duration, captions preference, daily posting limits, publishing mode, destination
preferences, and an activity log. Records are isolated by the authenticated
Sites user. Mutations and their audit entries are committed in D1 batches.

A self-hosted clip worker (`worker/`, see its README) can be connected with a
per-user token created in the dashboard. Only the token's SHA-256 is stored;
creating a new token revokes the old one. The worker reads its config from
`GET /api/worker/config` and reports finished clips to `POST /api/worker/clips`,
then uploads the file to `PUT /api/worker/clips/:id/file`. The upload must match
the reported SHA-256 and size and is stored in R2 (`BUCKET`); without the bucket
the endpoint returns 501 and the file stays on the worker. Owners stream clips
from `GET /api/clips/:id/file` (Range supported) and can delete them, which
removes the R2 object first. R2 has no automatic retention; clips persist until
deleted.

Live detection: while control is running, the worker checks each enabled
streamer with `streamlink --json` (no media download) every `LIVE_CHECK_SECONDS`
and posts live/recording/offline/error to `POST /api/worker/status`; the
dashboard treats statuses older than 15 minutes as unchecked. Captures start
only for streamers confirmed live. This is polling, not push: a stream can be
detected up to one check interval late, and "error" means the check itself
failed, not that the channel is offline. `engine.connected` means the worker
polled within five minutes.

Highlights: live streamers are recorded into a rolling on-disk buffer. Twitch
chat is read anonymously and a spike above the channel's own typical rate
triggers a clip; otherwise the loudest recent stretch is clipped periodically.
Kick and YouTube are audio-only because their chat needs registered API apps
(Kick's web chat uses an undocumented token flow, deliberately not used). Clip
edges are snapped to transcript sentence boundaries.

The publishing view is an empty state. Analytics are unavailable, not
simulated. Integration cards describe setup; they do not perform OAuth.
No social account connection, publishing, or metric collection runs in this
version.

The worker authenticates with a bearer token, not Sites sign-in. If the Site's
private access boundary blocks unauthenticated requests before they reach the
app, the worker cannot connect; this must be verified on the hosted Site.

## Required production services

The dashboard's Cloudflare Worker is not a long-running FFmpeg host.
An external service must provide:

1. Twitch EventSub / Kick live events and YouTube live-status polling, with
   reconciliation after missed events and provider-specific rate limits.
2. A durable job queue and session identity. Deduplicate on provider, channel,
   stream ID, and job kind. Check global and per-streamer control before every
   capture, render, and publish step.
3. Permitted media ingestion, bounded rolling storage, highlight selection,
   transcription, FFmpeg rendering, vertical framing, and caption compositing.
4. Object storage with expiring access URLs and a configurable retention limit.
5. Social-provider OAuth adapters. Keep state and PKCE where supported, validate
   callbacks, encrypt tokens, refresh safely, and revoke access on disconnect.
6. Platform-specific publishing adapters and approval flows. Daily caps,
   idempotency, backoff, reconciliation after uncertain responses, and a dead
   letter queue are needed to prevent duplicate posts.
7. Analytics collection using provider metrics with collection timestamps and
   explicit unavailable states. Do not equate platform-specific view definitions.

Implement and deploy these services before changing engine.connected or replacing
empty library, publishing, or analytics data in the API. Merely adding credentials
does not activate functionality that has not been implemented.

## Accounts and deployment

Production uses Sites' private access boundary and authenticated user headers.
The dashboard API additionally rejects requests without identity and scopes every
query to the current user. Keep the Site private. Never trust user-supplied owner
IDs or expose social access tokens to the browser.

The Sites manifest declares D1 as DB. Schema migrations are generated with
Drizzle and applied by Sites during deployment. Use the Sites build and publish
workflow. The portable local preview supports mock ChatGPT sign-in only on
loopback; production does not include that simulation.

## Platform constraints

Public channel visibility is not a grant of rights to republish the content.
Use permitted media sources and respect provider restrictions. YouTube Data API
does not provide a general stream downloader. TikTok public API posting requires
an audit and its posting UX/consent requirements can conflict with unattended
cross-posting. Account and application eligibility must be verified separately
for every provider.

## End-to-end acceptance before activation

- Verify live detection, offline recovery, and missed-event reconciliation.
- Create a real clip from a permitted source and inspect captions and framing.
- Publish to each authorized test account and reconcile its provider post ID.
- Test pause and stop during capture, rendering, upload, and provider retries.
- Verify caps and duplicate prevention under concurrent deliveries.
- Verify token expiry, revoked consent, provider errors, storage retention,
  account isolation, and analytics freshness.
