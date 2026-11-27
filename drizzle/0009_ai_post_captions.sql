ALTER TABLE `clips` ADD `post_caption` text;--> statement-breakpoint
ALTER TABLE `clips` ADD `caption_source` text;--> statement-breakpoint
ALTER TABLE `clips` ADD `caption_tries` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `clips` ADD `caption_error` text;--> statement-breakpoint
ALTER TABLE `preferences` ADD `ai_captions` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `preferences` ADD `caption_notes` text DEFAULT '' NOT NULL;