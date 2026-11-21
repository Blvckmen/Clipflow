CREATE TABLE `recording_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`recording_id` text NOT NULL,
	`kind` text NOT NULL,
	`start` integer,
	`end` integer,
	`count` integer,
	`state` text DEFAULT 'queued' NOT NULL,
	`error` text,
	`clips` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `recording_requests_recording` ON `recording_requests` (`recording_id`);--> statement-breakpoint
CREATE INDEX `recording_requests_owner_state` ON `recording_requests` (`owner`,`state`);--> statement-breakpoint
CREATE TABLE `recordings` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`streamer_id` text NOT NULL,
	`title` text,
	`started_at` text NOT NULL,
	`ended_at` text,
	`duration` integer,
	`size` integer,
	`state` text DEFAULT 'recording' NOT NULL,
	`error` text,
	`signals` text,
	`preview_key` text,
	`preview_size` integer,
	`upload_id` text,
	`upload_parts` text,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `recordings_owner_started` ON `recordings` (`owner`,`started_at`);--> statement-breakpoint
ALTER TABLE `preferences` ADD `recording_days` integer DEFAULT 7 NOT NULL;--> statement-breakpoint
ALTER TABLE `streamers` ADD `capture_mode` text DEFAULT 'clip' NOT NULL;