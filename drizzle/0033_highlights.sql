CREATE TABLE `highlights` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`streamer_id` text,
	`title` text NOT NULL,
	`since` text NOT NULL,
	`until` text NOT NULL,
	`clips` text NOT NULL,
	`state` text NOT NULL,
	`file_key` text,
	`size` integer,
	`duration` real,
	`error` text,
	`auto` integer DEFAULT 0 NOT NULL,
	`upload_id` text,
	`upload_parts` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `highlights_owner_state` ON `highlights` (`owner`,`state`);--> statement-breakpoint
ALTER TABLE `preferences` ADD `weekly_highlights` integer DEFAULT false NOT NULL;