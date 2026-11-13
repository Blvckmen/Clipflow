CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`message` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `events_owner_created` ON `events` (`owner`,`created_at`);--> statement-breakpoint
CREATE TABLE `preferences` (
	`owner` text PRIMARY KEY NOT NULL,
	`mode` text DEFAULT 'automatic' NOT NULL,
	`duration` integer DEFAULT 45 NOT NULL,
	`daily_limit` integer DEFAULT 5 NOT NULL,
	`captions` integer DEFAULT true NOT NULL,
	`destinations` text DEFAULT '[]' NOT NULL,
	`control` text DEFAULT 'paused' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `streamers` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`platform` text NOT NULL,
	`status` text DEFAULT 'armed' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `streamers_owner_url` ON `streamers` (`owner`,`url`);