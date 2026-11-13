CREATE TABLE `clips` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`streamer_id` text NOT NULL,
	`created_at` text NOT NULL,
	`duration` integer NOT NULL,
	`captions` integer NOT NULL,
	`sha` text NOT NULL,
	`size` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `clips_owner_created` ON `clips` (`owner`,`created_at`);--> statement-breakpoint
CREATE TABLE `worker_tokens` (
	`owner` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` text NOT NULL,
	`last_seen` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `worker_tokens_hash` ON `worker_tokens` (`token_hash`);