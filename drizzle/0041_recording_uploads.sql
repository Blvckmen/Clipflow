CREATE TABLE `recording_uploads` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`streamer_id` text NOT NULL,
	`name` text NOT NULL,
	`size` integer NOT NULL,
	`clip_count` integer DEFAULT 0 NOT NULL,
	`upload_id` text,
	`parts` text DEFAULT '[]' NOT NULL,
	`complete` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `recording_uploads_owner` ON `recording_uploads` (`owner`,`complete`);