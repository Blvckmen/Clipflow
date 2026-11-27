ALTER TABLE `clips` ADD `queue_check` text;--> statement-breakpoint
CREATE INDEX `clips_streamer_review` ON `clips` (`streamer_id`,`review`);--> statement-breakpoint
CREATE INDEX `clips_owner_render` ON `clips` (`owner`,`render_state`);--> statement-breakpoint
CREATE INDEX `clips_created` ON `clips` (`created_at`);--> statement-breakpoint
CREATE INDEX `clips_owner_reviewed` ON `clips` (`owner`,`reviewed_at`);--> statement-breakpoint
CREATE INDEX `posts_account_state` ON `posts` (`account_id`,`state`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `posts_owner_created` ON `posts` (`owner`,`created_at`);--> statement-breakpoint
CREATE INDEX `posts_media` ON `posts` (`media_id`);--> statement-breakpoint
CREATE INDEX `posts_container` ON `posts` (`container_id`);--> statement-breakpoint
CREATE INDEX `recordings_expires` ON `recordings` (`expires_at`);--> statement-breakpoint
CREATE INDEX `clips_queue_check` ON `clips` (`queue_check`) WHERE `queue_check` IS NOT NULL;--> statement-breakpoint
CREATE TRIGGER `clips_queue_check_insert` AFTER INSERT ON `clips` BEGIN UPDATE `clips` SET `queue_check`=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE `id`=NEW.`id`; END;--> statement-breakpoint
CREATE TRIGGER `clips_queue_check_update` AFTER UPDATE OF `review`,`file_key`,`render_state` ON `clips` BEGIN UPDATE `clips` SET `queue_check`=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE `id`=NEW.`id`; END;--> statement-breakpoint
UPDATE `clips` SET `queue_check`=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE `review`='approved' AND coalesce(`reviewed_at`,`created_at`)>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days');
