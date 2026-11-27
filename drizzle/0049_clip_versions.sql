CREATE TABLE `clip_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`clip_id` text NOT NULL,
	`owner` text NOT NULL,
	`rev` integer NOT NULL,
	`edit` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `clip_versions_clip_rev` ON `clip_versions` (`clip_id`,`rev`);