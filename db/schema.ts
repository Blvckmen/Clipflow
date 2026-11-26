import { sql } from "drizzle-orm";
import { integer, primaryKey, real, sqliteTable, text, uniqueIndex, index } from "drizzle-orm/sqlite-core";
export const streamers = sqliteTable("streamers", {
 id:text("id").primaryKey(),owner:text("owner").notNull(),name:text("name").notNull(),url:text("url").notNull(),platform:text("platform").notNull(),status:text("status").notNull().default("armed"),createdAt:text("created_at").notNull(),
 // Reported by the worker: live, recording, offline, or error.
 liveStatus:text("live_status"),liveCheckedAt:text("live_checked_at"),liveTitle:text("live_title"),
 // This streamer's clip look (JSON style, see worker/edit.mjs); null uses the workspace's.
 style:text("style"),
 // clip: clip live (the rolling buffer only). record: keep the whole stream and clip it when it ends. both: clip
 // live and keep the whole stream.
 captureMode:text("capture_mode").notNull().default("clip"),
 // What happens to this streamer's new clips: "review" (wait for review), "automatic" (approved, so they post
 // straight away), or null to follow the workspace's publishing mode.
 publishMode:text("publish_mode"),
 // This streamer's transcription, subtitles and automatic hook: JSON {transcribe,subtitles,hook}, each true, false or
 // left out to follow the workspace. Null follows the workspace for all three.
 clipText:text("clip_text"),
 // Recording priority: when more streamers are live than the worker can record, lower numbers are recorded first
 // (and take a slot from a lower-ranked one). Null ranks after every numbered streamer, oldest first.
 priority:integer("priority"),
 // Posting rules for this streamer's clips (lib/posting-rules.mjs): a credit line, and a clipping campaign's label,
 // hashtags, mentions and clip lengths. JSON; null credits the streamer and has no campaign.
 postingRules:text("posting_rules"),
 // Learned from how this streamer's posted clips did (lib/insights.mjs), refreshed with the analytics: JSON
 // {chatWeight} (how much the worker weighs chat against loudness when picking a moment). Null: nothing learned yet.
 learned:text("learned"),
 // Viewers' Twitch clips for this streamer (lib/viewer-clips.mjs): JSON {on,minViews,perDay,maxHours,ask}, each left
 // out to follow the workspace. Null follows the workspace for all.
 viewerClips:text("viewer_clips"),
 // Most clips a day from this streamer (1-100); null follows the workspace's daily limit.
 dailyLimit:integer("daily_limit"),
},t=>[uniqueIndex("streamers_owner_url").on(t.owner,t.url)]);
export const preferences=sqliteTable("preferences",{
 owner:text("owner").primaryKey(),// The column default stays "automatic" (changing it needs a table rebuild); every INSERT sets mode itself, "review"
 // for a new workspace (lib/clipflow.ts defaults.mode), so the default is never used.
 mode:text("mode").notNull().default("automatic"),duration:integer("duration").notNull().default(45),dailyLimit:integer("daily_limit").notNull().default(5),captions:integer("captions",{mode:"boolean"}).notNull().default(true),destinations:text("destinations").notNull().default('[]'),control:text("control").notNull().default("paused"),framing:text("framing").notNull().default("blur"),
 // Post caption; {streamer} and {platform} are replaced with the clip's channel name and source platform.
 captionTemplate:text("caption_template").notNull().default("{streamer} on {platform} #clips #{platform}"),
 // The workspace's default clip look (JSON style); null uses the built-in one with `framing` and `captions`.
 style:text("style"),
 // Post captions written by Claude from each clip's transcript (when the site has an Anthropic API key), with
 // the owner's own guidance; caption_template is the fallback.
 aiCaptions:integer("ai_captions",{mode:"boolean"}).notNull().default(true),captionNotes:text("caption_notes").notNull().default(""),
 // Whether the worker transcribes new clips. Off skips Whisper: no subtitles, no sentence-aligned cuts.
 transcribe:integer("transcribe",{mode:"boolean"}).notNull().default(true),
 // Days full stream recordings are kept (on the worker PC, and their previews in R2).
 recordingDays:integer("recording_days").notNull().default(7),
 // Viewers' Twitch clips: the fewest views a clip needs for the worker to import it (0: off).
 importClips:integer("import_clips").notNull().default(0),
 // The rest of the viewers' clips settings (lib/viewer-clips.mjs): JSON {perDay,maxHours,ask}; null: the defaults.
 viewerClips:text("viewer_clips"),
 // Who can clip with "!clip" in Twitch chat: "mods" (the streamer, moderators and VIPs), "everyone" (also 3 viewers
 // within 30 seconds), or "off".
 clipCommand:text("clip_command").notNull().default("mods"),
 // Discord alerts (lib/alerts.ts): the webhook link, encrypted with TOKEN_KEY; when the last review alert went out; and
 // why the last one failed (null when it worked).
 discordWebhookEnc:text("discord_webhook_enc"),alertAt:text("alert_at"),alertError:text("alert_error"),
 // Whether the worker uses what was learned from views (streamers.learned) when it picks moments.
 learn:integer("learn",{mode:"boolean"}).notNull().default(true),
 // Make a highlight video of the past week every Monday (lib/highlights.ts).
 weeklyHighlights:integer("weekly_highlights",{mode:"boolean"}).notNull().default(false),
 // Settings → This PC (lib/clipflow.ts workerSettingsSchema): JSON choices the worker uses instead of its .env; null:
 // the worker's own setup for all of them.
 workerSettings:text("worker_settings"),
 // No longer used: the single Zernio key setting, moved to zernio_keys by migration 0011.
 zernioKeyEnc:text("zernio_key_enc"),zernioLabel:text("zernio_label"),
});
export const events=sqliteTable("events",{id:text("id").primaryKey(),owner:text("owner").notNull(),message:text("message").notNull(),createdAt:text("created_at").notNull()},t=>[index("events_owner_created").on(t.owner,t.createdAt)]);
// Pairing codes (lib/pairing.ts): a short one-time code from Connect worker that a PC trades for a worker token
// (POST /api/worker/pair). Only its SHA-256 is stored; one per owner, gone once used or after PAIR_TTL_MS.
export const pairingCodes=sqliteTable("pairing_codes",{codeHash:text("code_hash").primaryKey(),owner:text("owner").notNull(),createdAt:text("created_at").notNull(),expiresAt:text("expires_at").notNull()},t=>[index("pairing_codes_owner").on(t.owner)]);
// Only the SHA-256 of a worker token is stored; the plaintext is shown once on creation.
export const workerTokens=sqliteTable("worker_tokens",{owner:text("owner").primaryKey(),tokenHash:text("token_hash").notNull(),createdAt:text("created_at").notNull(),lastSeen:text("last_seen"),
 // Most recent problem the worker reported, shown in the dashboard.
 lastError:text("last_error"),lastErrorAt:text("last_error_at"),
 // What the worker last said about itself (JSON, app/api/worker/status): the settings fingerprint it runs with, what
 // it's doing (channels recording, clips being made or waiting), the values it uses and the PC's cores and memory.
 device:text("device"),deviceAt:text("device_at"),
 // When a restart was asked for from Settings → This PC; the worker restarts once nothing is recording or being made.
 restartAt:text("restart_at")},t=>[uniqueIndex("worker_tokens_hash").on(t.tokenHash)]);
export const clips=sqliteTable("clips",{
 id:text("id").primaryKey(),owner:text("owner").notNull(),streamerId:text("streamer_id").notNull(),createdAt:text("created_at").notNull(),duration:integer("duration").notNull(),captions:integer("captions",{mode:"boolean"}).notNull(),sha:text("sha").notNull(),size:integer("size").notNull(),
 // R2 object key once the worker has uploaded the file; null while the file is only on the worker.
 fileKey:text("file_key"),
 // pending | approved | rejected. Review mode makes new clips pending; automatic mode approves them on arrival.
 review:text("review").notNull().default("approved"),reviewedAt:text("reviewed_at"),
 // What made the worker cut this clip: "chat" (chat spike) or "audio" (loudest recent moment).
 reason:text("reason"),
 // Editor material, reported by the worker: the unframed source in R2 (with its hash and size, checked on upload),
 // the transcript words, the per-second loudness/chat heat strip and the source's size and length (all JSON).
 sourceKey:text("source_key"),sourceSha:text("source_sha"),sourceSize:integer("source_size"),
 transcript:text("transcript"),signals:text("signals"),sourceMeta:text("source_meta"),
 // The edit the current file was (or is about to be) rendered with. Saving an edit bumps edit_rev and sets
 // render_state to queued; the worker renders that revision and the upload clears it (or sets failed).
 edit:text("edit"),editRev:integer("edit_rev").notNull().default(0),renderState:text("render_state"),renderError:text("render_error"),renderedAt:text("rendered_at"),
 // The text posted with the clip. caption_source: "ai" (written by Claude, regenerated on request) or "edited"
 // (typed by the owner, never overwritten). Null caption: not written yet, so the template is used.
 // When the clip last changed in a way that can make it ready to post (arrived, approved, file uploaded, render
 // finished), set by database triggers (migration 0021); null once the publisher has looked at it. The publisher only
 // reads flagged clips, so its once-a-minute run doesn't read the whole clip history.
 queueCheck:text("queue_check"),
 // The edit_rev of the library thumbnail (a JPEG still in R2 at thumbs/<owner>/<id>-<rev>.jpg), taken by the browser
 // the first time the clip is shown; a thumbnail of an older revision is replaced the next time the clip is shown.
 thumbRev:integer("thumb_rev"),
 postCaption:text("post_caption"),captionSource:text("caption_source"),captionTries:integer("caption_tries").notNull().default(0),captionError:text("caption_error"),
},t=>[index("clips_owner_created").on(t.owner,t.createdAt),
 // Indexes for the frequent reads (the once-a-minute publisher, the worker's config poll, the dashboard's analytics):
 // without them each of those reads every clip, which runs past D1's daily row-read allowance.
 index("clips_streamer_review").on(t.streamerId,t.review),index("clips_owner_render").on(t.owner,t.renderState),
 index("clips_created").on(t.createdAt),index("clips_owner_reviewed").on(t.owner,t.reviewedAt),
 // Clips still waiting for a written caption (lib/post-caption.ts fillCaptions, every minute): only those are read.
 index("clips_caption_due").on(t.createdAt).where(sql`${t.postCaption} IS NULL AND ${t.captionTries} < 3`)]);
// Connected publishing accounts; an owner can connect several per platform. The access token is AES-GCM
// encrypted with the TOKEN_KEY secret.
// provider "instagram": connected directly with Instagram Login, token stored here. provider "zernio": connected on
// Zernio and posted through the site's ZERNIO_API_KEY; external_id is Zernio's account id and no token is stored.
export const accounts=sqliteTable("accounts",{
 id:text("id").primaryKey(),owner:text("owner").notNull(),provider:text("provider").notNull().default("instagram"),platform:text("platform").notNull(),externalId:text("external_id").notNull(),username:text("username").notNull(),
 tokenEnc:text("token_enc").notNull(),tokenExpiresAt:text("token_expires_at").notNull(),tokenRefreshedAt:text("token_refreshed_at").notNull(),
 // connected | expired (needs reconnecting). Only clips approved after connected_at are published.
 status:text("status").notNull().default("connected"),connectedAt:text("connected_at").notNull(),lastError:text("last_error"),
 // Per-account posting options set in the dashboard (JSON, see lib/account-options.ts); null uses the defaults.
 options:text("options"),
 // Zernio accounts: which of the workspace's Zernio keys this account belongs to (zernio_keys.id). Null means the
 // site-wide ZERNIO_API_KEY.
 zernioKeyId:text("zernio_key_id"),
},t=>[uniqueIndex("accounts_owner_platform_external").on(t.owner,t.platform,t.externalId)]);
// A workspace's Zernio API keys, added in the dashboard. Each key is a separate Zernio account with its own
// connected social accounts. key_enc is AES-GCM with TOKEN_KEY; key_hash (SHA-256) stops the same key being added
// twice; label is who the key belongs to, for display.
export const zernioKeys=sqliteTable("zernio_keys",{
 id:text("id").primaryKey(),owner:text("owner").notNull(),label:text("label").notNull(),keyEnc:text("key_enc").notNull(),keyHash:text("key_hash").notNull(),
 createdAt:text("created_at").notNull(),lastError:text("last_error"),
},t=>[uniqueIndex("zernio_keys_owner_hash").on(t.owner,t.keyHash),index("zernio_keys_owner").on(t.owner)]);
// Which accounts post which streamer's clips. Only clips approved after the link was made are posted.
export const streamerAccounts=sqliteTable("streamer_accounts",{
 streamerId:text("streamer_id").notNull(),accountId:text("account_id").notNull(),owner:text("owner").notNull(),createdAt:text("created_at").notNull(),
},t=>[primaryKey({columns:[t.streamerId,t.accountId]}),index("streamer_accounts_account").on(t.accountId)]);
// One row per clip per account per round. The publisher queues round 0 by itself, once; posting a clip again by
// hand (after editing it, say) adds the next round, so the automatic queue never posts a clip twice.
export const posts=sqliteTable("posts",{
 id:text("id").primaryKey(),owner:text("owner").notNull(),clipId:text("clip_id").notNull(),platform:text("platform").notNull(),accountId:text("account_id").notNull(),
 // queued -> processing (container created) -> published | failed. A post made once its account has reached its daily
 // limit (its own, or TikTok's 15) starts as review if the account is set to hold (account-options whenFull): the
 // owner queues it (queued) or skips it (skipped, never posted).
 state:text("state").notNull().default("queued"),containerId:text("container_id"),mediaId:text("media_id"),permalink:text("permalink"),error:text("error"),
 attempts:integer("attempts").notNull().default(0),nextAttemptAt:text("next_attempt_at").notNull(),createdAt:text("created_at").notNull(),updatedAt:text("updated_at").notNull(),publishedAt:text("published_at"),
 round:integer("round").notNull().default(0),
 // Sent to the account's TikTok drafts (to be finished in the app) rather than published directly.
 draft:integer("draft",{mode:"boolean"}).notNull().default(false),
 // Queued by the owner (posted by hand, or queued from review): waits for room rather than being held for review.
 queuedByHand:integer("queued_by_hand",{mode:"boolean"}).notNull().default(false),
 // The time the owner picked for it on the calendar (it waits until then, then skips the posting hours); null: automatic.
 scheduledFor:text("scheduled_for"),
 // Performance read from the platform (through Zernio's analytics, about hourly); null until first read.
 views:integer("views"),likes:integer("likes"),comments:integer("comments"),shares:integer("shares"),saves:integer("saves"),metricsAt:text("metrics_at"),
},t=>[uniqueIndex("posts_clip_account_round").on(t.clipId,t.accountId,t.round),index("posts_owner_state").on(t.owner,t.state),
 // The publisher's per-account lookups, and the dashboard's newest posts.
 index("posts_account_state").on(t.accountId,t.state,t.nextAttemptAt),index("posts_owner_created").on(t.owner,t.createdAt),
 // The publisher's every-minute count of an account's posts in the last day (its daily limit): reads that day only.
 index("posts_account_published").on(t.accountId,t.state,t.publishedAt),
 // The hourly analytics sync matches each post by the platform's post id or the Zernio post id.
 index("posts_media").on(t.mediaId),index("posts_container").on(t.containerId)]);
// When each periodic job last ran (e.g. "analytics:<owner>:<zernio key id or site>"), so the once-a-minute cron
// trigger can run slower jobs on their own schedule.
export const syncState=sqliteTable("sync_state",{key:text("key").primaryKey(),at:text("at").notNull(),note:text("note")});
// Whole streams kept by the worker (capture mode record or both). The full-quality file stays on the worker PC;
// a small preview is uploaded to R2 (previews/<id>.mp4, in parts) so the owner can scrub it and pick clips.
// state: recording -> processing (joining, measuring, preview) -> ready | failed. Deleted rows go entirely.
export const recordings=sqliteTable("recordings",{
 id:text("id").primaryKey(),owner:text("owner").notNull(),streamerId:text("streamer_id").notNull(),title:text("title"),
 startedAt:text("started_at").notNull(),endedAt:text("ended_at"),duration:integer("duration"),size:integer("size"),
 state:text("state").notNull().default("recording"),error:text("error"),
 // A video imported from a link (Twitch/Kick VOD, YouTube): the link, rebuilt by worker/video-link.mjs. Such a
 // recording starts "queued" (waiting for the worker PC), then "importing" while it downloads.
 sourceUrl:text("source_url"),
 // Heat strip: {step (seconds per bar), energy: [0-1], chat: [counts]}.
 signals:text("signals"),
 previewKey:text("preview_key"),previewSize:integer("preview_size"),
 // When the worker finished transcribing the whole recording (for searching what was said); the transcript itself is
 // in R2 at transcripts/<id>.json. Null: not transcribed (yet).
 transcriptAt:text("transcript_at"),
 // R2 multipart upload in progress: its id and the parts received so far (JSON [{partNumber, etag}]).
 uploadId:text("upload_id"),uploadParts:text("upload_parts"),
 expiresAt:text("expires_at").notNull(),createdAt:text("created_at").notNull(),
},t=>[index("recordings_owner_started").on(t.owner,t.startedAt),index("recordings_expires").on(t.expiresAt)]);
// Clips asked for from a recording: one moment (start/end seconds into it) or "find the best `count` moments".
// state: queued -> working -> done | failed.
export const recordingRequests=sqliteTable("recording_requests",{
 id:text("id").primaryKey(),owner:text("owner").notNull(),recordingId:text("recording_id").notNull(),kind:text("kind").notNull(),
 start:integer("start"),end:integer("end"),count:integer("count"),
 state:text("state").notNull().default("queued"),error:text("error"),clips:integer("clips").notNull().default(0),
 createdAt:text("created_at").notNull(),updatedAt:text("updated_at").notNull(),
},t=>[index("recording_requests_recording").on(t.recordingId),index("recording_requests_owner_state").on(t.owner,t.state)]);
// Split-screen background videos a workspace has uploaded (stored in R2 under backgrounds/<id>.mp4).
export const backgrounds=sqliteTable("backgrounds",{
 id:text("id").primaryKey(),owner:text("owner").notNull(),name:text("name").notNull(),key:text("key").notNull(),size:integer("size").notNull(),
 contentType:text("content_type").notNull(),createdAt:text("created_at").notNull(),
 // Length in seconds, measured by the browser that uploaded it (or later in Settings); null until known.
 duration:real("duration"),
},t=>[index("backgrounds_owner").on(t.owner)]);

// A clip in another language for accounts set to post in it (account option subtitleLanguage): subtitles, hook and
// post caption translated on the worker PC, rendered from the clip's edit revision `rev`. state: queued (asked for
// by the publisher) -> ready (file_key) | failed (error). source_caption: the post caption to translate, fixed when
// asked for; caption: its translation. The publisher applies the streamer's posting rules after translating.
export const clipTranslations=sqliteTable("clip_translations",{
 clipId:text("clip_id").notNull(),owner:text("owner").notNull(),lang:text("lang").notNull(),rev:integer("rev").notNull(),
 state:text("state").notNull(),fileKey:text("file_key"),sourceCaption:text("source_caption"),caption:text("caption"),error:text("error"),
 createdAt:text("created_at").notNull(),updatedAt:text("updated_at").notNull(),
},t=>[primaryKey({columns:[t.clipId,t.lang]}),index("clip_translations_owner_state").on(t.owner,t.state)]);

// Highlight videos (lib/highlights.ts): the clips picked (JSON [{id,start,end}], in order), made into one 16:9 video
// by the worker and uploaded in parts like a recording's preview. state: queued -> ready (file_key) | failed (error).
export const highlights=sqliteTable("highlights",{
 id:text("id").primaryKey(),owner:text("owner").notNull(),streamerId:text("streamer_id"),title:text("title").notNull(),
 since:text("since").notNull(),until:text("until").notNull(),clips:text("clips").notNull(),state:text("state").notNull(),
 fileKey:text("file_key"),size:integer("size"),duration:real("duration"),error:text("error"),auto:integer("auto").notNull().default(0),
 uploadId:text("upload_id"),uploadParts:text("upload_parts"),createdAt:text("created_at").notNull(),updatedAt:text("updated_at").notNull(),
},t=>[index("highlights_owner_state").on(t.owner,t.state)]);

// Viewers' Twitch clips found by the worker while a streamer is set to "ask me first": they wait here until the owner
// picks them (state waiting -> wanted, then imported or failed when the worker has made them) or dismisses them.
// clip_id is Twitch's. moment_at: when it happened in the stream, as far as known.
export const viewerClipCandidates=sqliteTable("viewer_clip_candidates",{
 owner:text("owner").notNull(),clipId:text("clip_id").notNull(),streamerId:text("streamer_id").notNull(),
 title:text("title").notNull(),views:integer("views").notNull(),duration:real("duration").notNull(),creator:text("creator"),thumbnail:text("thumbnail"),
 clipCreatedAt:text("clip_created_at").notNull(),momentAt:text("moment_at"),videoId:text("video_id"),vodOffset:integer("vod_offset"),
 state:text("state").notNull(),error:text("error"),madeClip:text("made_clip"),createdAt:text("created_at").notNull(),updatedAt:text("updated_at").notNull(),
},t=>[primaryKey({columns:[t.owner,t.clipId]}),index("viewer_clip_candidates_owner_state").on(t.owner,t.state)]);

export const recordingUploads=sqliteTable("recording_uploads",{id:text("id").primaryKey(),owner:text("owner").notNull(),streamerId:text("streamer_id").notNull(),name:text("name").notNull(),size:integer("size").notNull(),clipCount:integer("clip_count").notNull().default(0),uploadId:text("upload_id"),parts:text("parts").notNull().default("[]"),complete:integer("complete").notNull().default(0),createdAt:text("created_at").notNull()},t=>[index("recording_uploads_owner").on(t.owner,t.complete)]);
