CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`platform` text NOT NULL,
	`external_id` text NOT NULL,
	`username` text NOT NULL,
	`token_enc` text NOT NULL,
	`token_expires_at` text NOT NULL,
	`token_refreshed_at` text NOT NULL,
	`status` text DEFAULT 'connected' NOT NULL,
	`connected_at` text NOT NULL,
	`last_error` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_owner_platform` ON `accounts` (`owner`,`platform`);--> statement-breakpoint
CREATE TABLE `posts` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`clip_id` text NOT NULL,
	`platform` text NOT NULL,
	`account_id` text NOT NULL,
	`state` text DEFAULT 'queued' NOT NULL,
	`container_id` text,
	`media_id` text,
	`permalink` text,
	`error` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`published_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `posts_clip_platform` ON `posts` (`clip_id`,`platform`);--> statement-breakpoint
CREATE INDEX `posts_owner_state` ON `posts` (`owner`,`state`);--> statement-breakpoint
ALTER TABLE `preferences` ADD `caption_template` text DEFAULT '{streamer} on {platform} #clips #{platform}' NOT NULL;