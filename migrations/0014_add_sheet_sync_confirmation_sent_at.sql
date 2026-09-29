-- Tracks whether the post-sync Telegram confirmation message for this job
-- has already been sent, so a retried/re-run job (e.g. an operator resetting
-- status back to 'pending' to re-sync edited OCR data) never sends a second
-- confirmation to the same group. NULL means "not sent yet" -- the normal
-- state for every job until syncPassportRowToSheet.ts successfully sends one.
ALTER TABLE sheet_sync_queue
  ADD COLUMN confirmation_sent_at TIMESTAMPTZ NULL;
