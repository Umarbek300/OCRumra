-- Operator-facing queue for every REVIEW decision outcome (agent mismatch,
-- or passport-number/DOB not both field-level HIGH). Append-only: a
-- resolved row is never deleted — the resolved row itself is the audit
-- record of how that review was decided, in addition to the fuller event
-- trail in passport_identity_events (0019).
CREATE TYPE duplicate_review_reason AS ENUM ('agent_mismatch', 'low_confidence_field', 'conflicting_fields');
CREATE TYPE duplicate_review_status AS ENUM ('pending', 'confirmed_duplicate', 'confirmed_distinct');

CREATE TABLE duplicate_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  passport_identity_id UUID NOT NULL REFERENCES passport_identity (id),
  candidate_telegram_message_id UUID NOT NULL REFERENCES telegram_messages (id),
  matched_against_telegram_message_id UUID REFERENCES telegram_messages (id),
  review_reason duplicate_review_reason NOT NULL,
  status duplicate_review_status NOT NULL DEFAULT 'pending',
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_duplicate_reviews_pending ON duplicate_reviews (created_at) WHERE status = 'pending';
CREATE INDEX idx_duplicate_reviews_identity ON duplicate_reviews (passport_identity_id);

-- At most one open (pending) review per candidate message — a message
-- already awaiting a decision must never be flagged into a second,
-- redundant review row.
CREATE UNIQUE INDEX idx_duplicate_reviews_one_pending_per_candidate
  ON duplicate_reviews (candidate_telegram_message_id)
  WHERE status = 'pending';
