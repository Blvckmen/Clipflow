CREATE TABLE `sync_state` (
	`key` text PRIMARY KEY NOT NULL,
	`at` text NOT NULL,
	`note` text
);
--> statement-breakpoint
ALTER TABLE `posts` ADD `views` integer;--> statement-breakpoint
ALTER TABLE `posts` ADD `likes` integer;--> statement-breakpoint
ALTER TABLE `posts` ADD `comments` integer;--> statement-breakpoint
ALTER TABLE `posts` ADD `shares` integer;--> statement-breakpoint
ALTER TABLE `posts` ADD `saves` integer;--> statement-breakpoint
ALTER TABLE `posts` ADD `metrics_at` text;