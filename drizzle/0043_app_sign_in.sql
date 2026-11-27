CREATE TABLE `auth_identities` (
	`provider` text NOT NULL,
	`provider_id` text NOT NULL,
	`owner` text NOT NULL,
	`login` text,
	`email` text,
	`display_name` text,
	`created_at` text NOT NULL,
	`last_sign_in` text,
	PRIMARY KEY(`provider`, `provider_id`)
);
--> statement-breakpoint
CREATE INDEX `auth_identities_owner` ON `auth_identities` (`owner`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`display_name` text,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sessions_owner` ON `sessions` (`owner`);