ALTER TABLE `clips` ADD `review` text DEFAULT 'approved' NOT NULL;--> statement-breakpoint
ALTER TABLE `clips` ADD `reviewed_at` text;--> statement-breakpoint
ALTER TABLE `clips` ADD `reason` text;