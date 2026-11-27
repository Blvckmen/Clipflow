ALTER TABLE `preferences` ADD `hooks` integer DEFAULT true NOT NULL;--> statement-breakpoint
-- Subtitles and opening titles no longer need transcription switched on (they transcribe a clip themselves). Where
-- transcription was off, they were off too: keep them off, so nothing changes until the owner turns them on.
UPDATE `preferences` SET `captions`=0, `hooks`=0 WHERE `transcribe`=0;--> statement-breakpoint
UPDATE `streamers` SET `clip_text`=json_set(`clip_text`,'$.subtitles',json('false'),'$.hook',json('false')) WHERE json_valid(`clip_text`) AND json_extract(`clip_text`,'$.transcribe')=0;--> statement-breakpoint
UPDATE `streamers` SET `clip_text`=json_set(`clip_text`,'$.subtitles',json('false')) WHERE json_valid(`clip_text`) AND json_type(`clip_text`,'$.transcribe') IS NULL AND json_extract(`clip_text`,'$.subtitles')=1 AND `owner` IN (SELECT `owner` FROM `preferences` WHERE `transcribe`=0);--> statement-breakpoint
UPDATE `streamers` SET `clip_text`=json_set(`clip_text`,'$.hook',json('false')) WHERE json_valid(`clip_text`) AND json_type(`clip_text`,'$.transcribe') IS NULL AND json_extract(`clip_text`,'$.hook')=1 AND `owner` IN (SELECT `owner` FROM `preferences` WHERE `transcribe`=0);
