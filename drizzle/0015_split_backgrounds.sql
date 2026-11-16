CREATE TABLE `backgrounds` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`name` text NOT NULL,
	`key` text NOT NULL,
	`size` integer NOT NULL,
	`content_type` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `backgrounds_owner` ON `backgrounds` (`owner`);