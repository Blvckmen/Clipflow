CREATE TABLE `billing` (
	`owner` text PRIMARY KEY NOT NULL,
	`plan` text,
	`status` text NOT NULL,
	`trial_ends_at` text,
	`stripe_customer` text,
	`stripe_subscription` text,
	`period_end` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `billing_customer` ON `billing` (`stripe_customer`);--> statement-breakpoint
-- Workspaces from before billing are comped (lib/plans.mjs): never limited.
INSERT OR IGNORE INTO `billing` (`owner`,`plan`,`status`,`updated_at`) SELECT `owner`,NULL,'comped',strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM (SELECT `owner` FROM `preferences` UNION SELECT `owner` FROM `streamers` UNION SELECT `owner` FROM `worker_tokens`);