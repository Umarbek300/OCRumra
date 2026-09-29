-- Telegram only attaches a caption to ONE message of a media group (album)
-- -- every other photo/document sent together with it arrives with
-- caption = NULL, even when the operator visibly typed one caption for the
-- whole album. This column records which album (if any) a message belongs
-- to, so ingestPhotoMessage.ts can correlate a caption across sibling
-- messages in the same album instead of losing it for every photo but one.
-- NULL for a message sent on its own (the normal, non-album case).
ALTER TABLE telegram_messages
  ADD COLUMN media_group_id TEXT NULL;

CREATE INDEX idx_telegram_messages_media_group
  ON telegram_messages (telegram_chat_id, media_group_id)
  WHERE media_group_id IS NOT NULL;
