CREATE TABLE `clip_copy` (
 `clip_id` text PRIMARY KEY NOT NULL,
 `owner` text NOT NULL,
 `transcript` text DEFAULT '' NOT NULL,
 `platform` text DEFAULT 'TikTok' NOT NULL,
 `tone` text DEFAULT 'curiosity' NOT NULL,
 `hooks_json` text DEFAULT '[]' NOT NULL,
 `captions_json` text DEFAULT '[]' NOT NULL,
 `selected_hook` text,
 `selected_caption` text,
 `status` text DEFAULT 'draft' NOT NULL,
 `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `clip_copy_owner` ON `clip_copy` (`owner`);
