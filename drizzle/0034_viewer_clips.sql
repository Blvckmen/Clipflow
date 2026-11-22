CREATE TABLE `viewer_clip_candidates` (
	`owner` text NOT NULL,
	`clip_id` text NOT NULL,
	`streamer_id` text NOT NULL,
	`title` text NOT NULL,
	`views` integer NOT NULL,
	`duration` real NOT NULL,
	`creator` text,
	`thumbnail` text,
	`clip_created_at` text NOT NULL,
	`moment_at` text,
	`video_id` text,
	`vod_offset` integer,
	`state` text NOT NULL,
	`error` text,
	`made_clip` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`owner`, `clip_id`)
);
--> statement-breakpoint
CREATE INDEX `viewer_clip_candidates_owner_state` ON `viewer_clip_candidates` (`owner`,`state`);--> statement-breakpoint
ALTER TABLE `preferences` ADD `viewer_clips` text;--> statement-breakpoint
ALTER TABLE `streamers` ADD `viewer_clips` text;