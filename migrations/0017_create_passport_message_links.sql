-- The operational layer: one row per Telegram message that has been
-- identity-resolved against passport_identity (0016). group_id/agent_id
-- are denormalized from telegram_messages at write time specifically so
-- the per-group canonical uniqueness constraint below can be expressed
-- directly on this table without a join, and so an agent-mismatch check
-- never has to reach across tables either.
--
-- Canonical is scoped per (passport_identity, group) — never globally per
-- identity — because each Group owns its own independent spreadsheet
-- (groups.google_sheet_id): the same real passport can have a different
-- canonical Telegram message in two different groups' sheets, entirely
-- independently. See ensureGroupSheet.ts.
--
-- role and link_status are two independent dimensions:
--   role         — canonical | duplicate (which message currently drives
--                  this group's Sheet row vs. which are known duplicates)
--   link_status  — active | cancelled | removed | moved (operator-driven
--                  outcomes from CANCEL_PASSPORT / REMOVE_FROM_GROUP /
--                  MOVE_TO_GROUP; a cancelled/removed/moved link must
--                  never block a new canonical from being assigned to the
--                  same (identity, group))
CREATE TYPE passport_link_role AS ENUM ('canonical', 'duplicate');
CREATE TYPE passport_link_status AS ENUM ('active', 'cancelled', 'removed', 'moved');
CREATE TYPE passport_match_confidence_tier AS ENUM ('high', 'review', 'new_identity');
CREATE TYPE passport_link_resolved_by AS ENUM ('auto', 'operator');

CREATE TABLE passport_message_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  passport_identity_id UUID NOT NULL REFERENCES passport_identity (id),
  telegram_message_id UUID NOT NULL UNIQUE REFERENCES telegram_messages (id) ON DELETE CASCADE,
  group_id UUID NOT NULL REFERENCES groups (id),
  agent_id UUID REFERENCES agents (id),
  role passport_link_role NOT NULL,
  link_status passport_link_status NOT NULL DEFAULT 'active',
  match_confidence_tier passport_match_confidence_tier NOT NULL,
  resolved_by passport_link_resolved_by NOT NULL DEFAULT 'auto',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One active canonical per (identity, group) — a cancelled/removed/moved
-- link is excluded, so a new canonical can always be (re)assigned to that
-- (identity, group) once the previous one leaves the active set.
CREATE UNIQUE INDEX idx_passport_message_links_one_active_canonical
  ON passport_message_links (passport_identity_id, group_id)
  WHERE role = 'canonical' AND link_status = 'active';

CREATE INDEX idx_passport_message_links_identity ON passport_message_links (passport_identity_id);
CREATE INDEX idx_passport_message_links_group ON passport_message_links (group_id);
CREATE INDEX idx_passport_message_links_active_duplicates
  ON passport_message_links (passport_identity_id, group_id)
  WHERE role = 'duplicate' AND link_status = 'active';
