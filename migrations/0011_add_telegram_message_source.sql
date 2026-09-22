-- Distinguishes messages ingested via Telegram's compressed "photo" upload
-- path from ones ingested via the uncompressed "document" path (added to
-- recover full-resolution passport photos: root-cause diagnostics showed
-- Telegram's photo pipeline caps images at ~1280px on the long edge and
-- re-encodes them, which can be enough on its own to break MRZ OCR).
--
-- Additive and backward-compatible: every existing row is a photo message,
-- so DEFAULT 'photo' backfills them with no separate UPDATE needed.
ALTER TABLE telegram_messages
  ADD COLUMN source TEXT NOT NULL DEFAULT 'photo' CHECK (source IN ('photo', 'document'));
