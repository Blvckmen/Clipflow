CREATE TABLE `zernio_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`label` text NOT NULL,
	`key_enc` text NOT NULL,
	`key_hash` text NOT NULL,
	`created_at` text NOT NULL,
	`last_error` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `zernio_keys_owner_hash` ON `zernio_keys` (`owner`,`key_hash`);--> statement-breakpoint
CREATE INDEX `zernio_keys_owner` ON `zernio_keys` (`owner`);--> statement-breakpoint
ALTER TABLE `accounts` ADD `zernio_key_id` text;--> statement-breakpoint
-- A key saved with the earlier single-key setting becomes the workspace's first key, and the Zernio accounts it
-- synced belong to it. Its hash is unknown here, so it gets a placeholder that can't match a real key.
INSERT OR IGNORE INTO `zernio_keys` (`id`,`owner`,`label`,`key_enc`,`key_hash`,`created_at`)
 SELECT 'legacy-' || `owner`, `owner`, coalesce(`zernio_label`, 'Zernio'), `zernio_key_enc`, 'legacy-' || `owner`, strftime('%Y-%m-%dT%H:%M:%fZ','now')
 FROM `preferences` WHERE `zernio_key_enc` IS NOT NULL;--> statement-breakpoint
UPDATE `accounts` SET `zernio_key_id` = 'legacy-' || `owner`
 WHERE `provider` = 'zernio' AND `owner` IN (SELECT `owner` FROM `preferences` WHERE `zernio_key_enc` IS NOT NULL);--> statement-breakpoint
UPDATE `preferences` SET `zernio_key_enc` = NULL, `zernio_label` = NULL WHERE `zernio_key_enc` IS NOT NULL;
