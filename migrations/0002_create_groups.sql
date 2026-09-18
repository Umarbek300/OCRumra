CREATE TABLE groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  departure_date DATE NOT NULL,
  telegram_chat_id BIGINT UNIQUE,
  google_sheet_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER groups_set_updated_at
  BEFORE UPDATE ON groups
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_groups_departure_date ON groups (departure_date);
