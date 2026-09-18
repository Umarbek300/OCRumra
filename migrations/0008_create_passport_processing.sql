-- One processing job per linked Telegram photo message. The UNIQUE
-- constraint on telegram_message_id is the idempotency guarantee: a
-- message can never get a second processing record.
CREATE TYPE passport_processing_status AS ENUM ('queued', 'processing', 'completed', 'failed');

CREATE TABLE passport_processing (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_message_id UUID NOT NULL UNIQUE REFERENCES telegram_messages (id) ON DELETE CASCADE,
  status passport_processing_status NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  queued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER passport_processing_set_updated_at
  BEFORE UPDATE ON passport_processing
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_passport_processing_status ON passport_processing (status);
