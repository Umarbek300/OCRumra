-- Global, document-level anchor for duplicate-passport detection. One row
-- per real physical passport, independent of which group/agent it was ever
-- sent through — never holds agent, package, deposit, balance, or any
-- other group-specific operational data (that lives on
-- passport_message_links / the Sheet row itself, see 0017).
--
-- UNIQUE(passport_number_normalized, date_of_birth) is the sole identity
-- key, enforced via the same idempotent INSERT ... ON CONFLICT DO NOTHING
-- idiom already used throughout this schema (telegram_messages,
-- passport_processing, passport_ocr_results). Deliberately does NOT
-- include nationality/issuer — see the design spec's own open-decision
-- note: adding a third noisy OCR field would trade a small, already-low
-- cross-country collision risk for a new false-negative surface.
--
-- Rows here are never physically deleted — only state-transitioned (see
-- status below). merged_into_identity_id supports the "two independently-
-- created identities later confirmed to be the same document" correction
-- path without ever losing either row's own history.
CREATE TYPE passport_identity_status AS ENUM ('active', 'archived_source_deleted', 'merged');

CREATE TABLE passport_identity (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  passport_number_normalized TEXT NOT NULL,
  date_of_birth DATE NOT NULL,
  -- Corroboration only, never part of the match key itself.
  mrz_checksum_valid BOOLEAN,
  status passport_identity_status NOT NULL DEFAULT 'active',
  merged_into_identity_id UUID REFERENCES passport_identity (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (passport_number_normalized, date_of_birth)
);

CREATE TRIGGER passport_identity_set_updated_at
  BEFORE UPDATE ON passport_identity
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_passport_identity_status ON passport_identity (status);
CREATE INDEX idx_passport_identity_merged_into ON passport_identity (merged_into_identity_id)
  WHERE merged_into_identity_id IS NOT NULL;
