CREATE TABLE `streamer_accounts` (
	`streamer_id` text NOT NULL,
	`account_id` text NOT NULL,
	`owner` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`streamer_id`, `account_id`)
);
--> statement-breakpoint
CREATE INDEX `streamer_accounts_account` ON `streamer_accounts` (`account_id`);--> statement-breakpoint
DROP INDEX `accounts_owner_platform`;--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_owner_platform_external` ON `accounts` (`owner`,`platform`,`external_id`);--> statement-breakpoint
DROP INDEX `posts_clip_platform`;--> statement-breakpoint
CREATE UNIQUE INDEX `posts_clip_account` ON `posts` (`clip_id`,`account_id`);--> statement-breakpoint
ALTER TABLE `clips` ADD `source_key` text;--> statement-breakpoint
ALTER TABLE `clips` ADD `source_sha` text;--> statement-breakpoint
ALTER TABLE `clips` ADD `source_size` integer;--> statement-breakpoint
ALTER TABLE `clips` ADD `transcript` text;--> statement-breakpoint
ALTER TABLE `clips` ADD `signals` text;--> statement-breakpoint
ALTER TABLE `clips` ADD `source_meta` text;--> statement-breakpoint
ALTER TABLE `clips` ADD `edit` text;--> statement-breakpoint
ALTER TABLE `clips` ADD `edit_rev` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `clips` ADD `render_state` text;--> statement-breakpoint
ALTER TABLE `clips` ADD `render_error` text;--> statement-breakpoint
ALTER TABLE `clips` ADD `rendered_at` text;--> statement-breakpoint
ALTER TABLE `preferences` ADD `style` text;--> statement-breakpoint
ALTER TABLE `streamers` ADD `style` text;--> statement-breakpoint
-- Before per-streamer routing, an Instagram account posted every streamer's clips when Instagram was a chosen
-- destination. Keep that behaviour for accounts connected before this migration.
INSERT OR IGNORE INTO `streamer_accounts` (`streamer_id`,`account_id`,`owner`,`created_at`)
 SELECT s.`id`, a.`id`, a.`owner`, a.`connected_at` FROM `accounts` a
 JOIN `streamers` s ON s.`owner` = a.`owner`
 JOIN `preferences` p ON p.`owner` = a.`owner`
 WHERE a.`platform` = 'instagram' AND p.`destinations` LIKE '%"Instagram"%';