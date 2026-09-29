-- Append-only audit/event history for every state-changing action this
-- feature performs, automatic or operator-triggered — canonical role on
-- passport_message_links captures only CURRENT state; this table is the
-- full timestamped history of how it got there. Never updated or deleted
-- after insert.
CREATE TYPE passport_identity_event_type AS ENUM (
  'identity_created',
  'message_linked_canonical',
  'message_linked_duplicate',
  'canonical_reassigned',
  'review_flagged',
  'review_resolved',
  'identity_merged',
  'identity_split',
  'cancel_passport',
  'remove_from_group',
  'group_transferred',
  'sheet_row_deleted',
  'identity_reactivated'
);
CREATE TYPE passport_identity_event_actor AS ENUM ('system', 'operator');

CREATE TABLE passport_identity_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  passport_identity_id UUID NOT NULL REFERENCES passport_identity (id),
  event_type passport_identity_event_type NOT NULL,
  group_id UUID REFERENCES groups (id),
  related_telegram_message_id UUID REFERENCES telegram_messages (id),
  actor passport_identity_event_actor NOT NULL,
  operator_id TEXT,
  -- Bounded/sanitized free text only — never OCR/passport field values, same
  -- discipline as syncPassportRowToSheet.ts's sanitizeErrorMessage.
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_passport_identity_events_identity ON passport_identity_events (passport_identity_id, created_at);
