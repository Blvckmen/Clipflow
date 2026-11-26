CREATE TABLE `clip_retries` (
	`owner` text NOT NULL,
	`clip_id` text NOT NULL,
	`requested_at` text NOT NULL,
	PRIMARY KEY(`owner`, `clip_id`)
);
--> statement-breakpoint
CREATE INDEX `clip_retries_owner_requested` ON `clip_retries` (`owner`,`requested_at`);