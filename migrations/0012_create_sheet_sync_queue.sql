-- One sync job per linked Telegram photo message whose OCR result is ready
-- to be written to that group's Google Sheet. Kept fully separate from
-- passport_processing: a Google Sheets outage must never affect OCR
-- pipeline status (queued/processing/completed/failed), and vice versa.
-- UNIQUE on telegram_message_id is the idempotency guarantee, same as
-- passport_processing: a message can never get a second sync job.
CREATE TYPE sheet_sync_status AS ENUM ('pending', 'syncing', 'synced', 'failed');

CREATE TABLE sheet_sync_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_message_id UUID NOT NULL UNIQUE REFERENCES telegram_messages (id) ON DELETE CASCADE,
  status sheet_sync_status NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  -- Set once this job's row is first written to the sheet; lets a retry
  -- (after e.g. a lost confirmation) UPDATE that same row in place instead
  -- of re-scanning the whole sheet or appending a duplicate row.
  sheet_row_number INTEGER,
  -- Backoff scheduling: a failed attempt pushes this forward rather than
  -- being retried immediately, so a sustained Sheets outage doesn't spin.
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER sheet_sync_queue_set_updated_at
  BEFORE UPDATE ON sheet_sync_queue
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_sheet_sync_queue_due
  ON sheet_sync_queue (next_attempt_at)
  WHERE status IN ('pending', 'failed');
