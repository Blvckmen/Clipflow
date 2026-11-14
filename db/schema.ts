import { integer, primaryKey, sqliteTable, text, uniqueIndex, index } from "drizzle-orm/sqlite-core";
export const streamers = sqliteTable("streamers", {
 id:text("id").primaryKey(),owner:text("owner").notNull(),name:text("name").notNull(),url:text("url").notNull(),platform:text("platform").notNull(),status:text("status").notNull().default("armed"),createdAt:text("created_at").notNull(),
 // Reported by the worker: live, recording, offline, or error.
 liveStatus:text("live_status"),liveCheckedAt:text("live_checked_at"),liveTitle:text("live_title"),
 // This streamer's clip look (JSON style, see worker/edit.mjs); null uses the workspace's.
 style:text("style"),
},t=>[uniqueIndex("streamers_owner_url").on(t.owner,t.url)]);
export const preferences=sqliteTable("preferences",{
 owner:text("owner").primaryKey(),mode:text("mode").notNull().default("automatic"),duration:integer("duration").notNull().default(45),dailyLimit:integer("daily_limit").notNull().default(5),captions:integer("captions",{mode:"boolean"}).notNull().default(true),destinations:text("destinations").notNull().default('[]'),control:text("control").notNull().default("paused"),framing:text("framing").notNull().default("blur"),
 // Post caption; {streamer} and {platform} are replaced with the clip's channel name and source platform.
 captionTemplate:text("caption_template").notNull().default("{streamer} on {platform} #clips #{platform}"),
 // The workspace's default clip look (JSON style); null uses the built-in one with `framing` and `captions`.
 style:text("style"),
});
export const events=sqliteTable("events",{id:text("id").primaryKey(),owner:text("owner").notNull(),message:text("message").notNull(),createdAt:text("created_at").notNull()},t=>[index("events_owner_created").on(t.owner,t.createdAt)]);
// Only the SHA-256 of a worker token is stored; the plaintext is shown once on creation.
export const workerTokens=sqliteTable("worker_tokens",{owner:text("owner").primaryKey(),tokenHash:text("token_hash").notNull(),createdAt:text("created_at").notNull(),lastSeen:text("last_seen"),
 // Most recent problem the worker reported, shown in the dashboard.
 lastError:text("last_error"),lastErrorAt:text("last_error_at")},t=>[uniqueIndex("worker_tokens_hash").on(t.tokenHash)]);
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
},t=>[index("clips_owner_created").on(t.owner,t.createdAt)]);
// Connected publishing accounts; an owner can connect several per platform. The access token is AES-GCM
// encrypted with the TOKEN_KEY secret.
// provider "instagram": connected directly with Instagram Login, token stored here. provider "zernio": connected on
// Zernio and posted through the site's ZERNIO_API_KEY; external_id is Zernio's account id and no token is stored.
export const accounts=sqliteTable("accounts",{
 id:text("id").primaryKey(),owner:text("owner").notNull(),provider:text("provider").notNull().default("instagram"),platform:text("platform").notNull(),externalId:text("external_id").notNull(),username:text("username").notNull(),
 tokenEnc:text("token_enc").notNull(),tokenExpiresAt:text("token_expires_at").notNull(),tokenRefreshedAt:text("token_refreshed_at").notNull(),
 // connected | expired (needs reconnecting). Only clips approved after connected_at are published.
 status:text("status").notNull().default("connected"),connectedAt:text("connected_at").notNull(),lastError:text("last_error"),
},t=>[uniqueIndex("accounts_owner_platform_external").on(t.owner,t.platform,t.externalId)]);
// Which accounts post which streamer's clips. Only clips approved after the link was made are posted.
export const streamerAccounts=sqliteTable("streamer_accounts",{
 streamerId:text("streamer_id").notNull(),accountId:text("account_id").notNull(),owner:text("owner").notNull(),createdAt:text("created_at").notNull(),
},t=>[primaryKey({columns:[t.streamerId,t.accountId]}),index("streamer_accounts_account").on(t.accountId)]);
// One row per clip per account, so a clip is never posted twice to the same account.
export const posts=sqliteTable("posts",{
 id:text("id").primaryKey(),owner:text("owner").notNull(),clipId:text("clip_id").notNull(),platform:text("platform").notNull(),accountId:text("account_id").notNull(),
 // queued -> processing (container created) -> published | failed
 state:text("state").notNull().default("queued"),containerId:text("container_id"),mediaId:text("media_id"),permalink:text("permalink"),error:text("error"),
 attempts:integer("attempts").notNull().default(0),nextAttemptAt:text("next_attempt_at").notNull(),createdAt:text("created_at").notNull(),updatedAt:text("updated_at").notNull(),publishedAt:text("published_at"),
},t=>[uniqueIndex("posts_clip_account").on(t.clipId,t.accountId),index("posts_owner_state").on(t.owner,t.state)]);
