CREATE TABLE `clip_translations` (
	`clip_id` text NOT NULL,
	`owner` text NOT NULL,
	`lang` text NOT NULL,
	`rev` integer NOT NULL,
	`state` text NOT NULL,
	`file_key` text,
	`source_caption` text,
	`caption` text,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`clip_id`, `lang`)
);
--> statement-breakpoint
CREATE INDEX `clip_translations_owner_state` ON `clip_translations` (`owner`,`state`);