import { integer, sqliteTable, text, uniqueIndex, index } from "drizzle-orm/sqlite-core";
export const streamers = sqliteTable("streamers", {
 id:text("id").primaryKey(),owner:text("owner").notNull(),name:text("name").notNull(),url:text("url").notNull(),platform:text("platform").notNull(),status:text("status").notNull().default("armed"),createdAt:text("created_at").notNull(),
 // Reported by the worker: live, recording, offline, or error.
 liveStatus:text("live_status"),liveCheckedAt:text("live_checked_at"),liveTitle:text("live_title"),
},t=>[uniqueIndex("streamers_owner_url").on(t.owner,t.url)]);
export const preferences=sqliteTable("preferences",{
 owner:text("owner").primaryKey(),mode:text("mode").notNull().default("automatic"),duration:integer("duration").notNull().default(45),dailyLimit:integer("daily_limit").notNull().default(5),captions:integer("captions",{mode:"boolean"}).notNull().default(true),destinations:text("destinations").notNull().default('[]'),control:text("control").notNull().default("paused"),framing:text("framing").notNull().default("blur"),
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
},t=>[index("clips_owner_created").on(t.owner,t.createdAt)]);
