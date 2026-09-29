-- Captures the photo/document message's own Telegram caption text, so a
-- later step (buildSheetRow.ts) can parse package/deposit amounts out of it.
-- Deliberately separate from passport_ocr_results: this is never passport
-- data, never touched by any OCR provider, and never affects OCR
-- extraction/confidence in any way. NULL for a message sent with no caption
-- (the normal case for most passport photos) or for every row that predates
-- this column -- both mean "nothing to parse", not "parsing failed".
ALTER TABLE telegram_messages
  ADD COLUMN caption_text TEXT NULL;
