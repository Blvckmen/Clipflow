DROP INDEX `posts_clip_account`;--> statement-breakpoint
ALTER TABLE `posts` ADD `round` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `posts_clip_account_round` ON `posts` (`clip_id`,`account_id`,`round`);