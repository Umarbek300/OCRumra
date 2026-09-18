-- One OCR result per linked Telegram photo message, kept fully separate
-- from the raw telegram_messages event data. UNIQUE on telegram_message_id
-- backs the "never call Claude twice for the same message" idempotency rule.
CREATE TYPE ocr_confidence_level AS ENUM ('high', 'medium', 'low');

CREATE TABLE passport_ocr_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_message_id UUID NOT NULL UNIQUE REFERENCES telegram_messages (id) ON DELETE CASCADE,

  first_name TEXT,
  first_name_confidence ocr_confidence_level,
  middle_name TEXT,
  middle_name_confidence ocr_confidence_level,
  surname TEXT,
  surname_confidence ocr_confidence_level,
  passport_number TEXT,
  passport_number_confidence ocr_confidence_level,
  date_of_birth DATE,
  date_of_birth_confidence ocr_confidence_level,
  passport_issue_date DATE,
  passport_issue_date_confidence ocr_confidence_level,
  passport_expiry_date DATE,
  passport_expiry_date_confidence ocr_confidence_level,
  gender customer_gender,
  gender_confidence ocr_confidence_level,
  nationality TEXT,
  nationality_confidence ocr_confidence_level,
  place_of_birth TEXT,
  place_of_birth_confidence ocr_confidence_level,
  issuing_authority TEXT,
  issuing_authority_confidence ocr_confidence_level,
  mrz TEXT,
  mrz_confidence ocr_confidence_level,

  overall_confidence ocr_confidence_level NOT NULL,
  raw_response JSONB NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER passport_ocr_results_set_updated_at
  BEFORE UPDATE ON passport_ocr_results
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_passport_ocr_results_telegram_message_id ON passport_ocr_results (telegram_message_id);
