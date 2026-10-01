-- Saudi visa automation, Phase 1: durable state for VisitSaudi's 10-
-- applicant-per-"Group application" batching. KSA Visa never batches (one
-- applicant, one package, see ksaVisaPackageBuilder.ts) but shares the same
-- portal enum for consistency with the rest of this feature's types.
--
-- Deliberately keyed by (group_id, passport_identity_id) -- the SAME stable
-- identity pair every other part of this schema addresses a passport by
-- (see passport_message_links) -- never by a Google Sheet row number/index,
-- which a human can reorder, insert into, or delete from at any time.
CREATE TYPE visa_portal AS ENUM ('visitsaudi', 'ksavisa');
CREATE TYPE visa_batch_status AS ENUM ('pending', 'submitted', 'completed', 'failed');
CREATE TYPE visa_batch_applicant_status AS ENUM ('active', 'cancelled', 'removed');

CREATE TABLE visa_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES groups (id),
  portal visa_portal NOT NULL,
  batch_number INTEGER NOT NULL,
  batch_name TEXT NOT NULL,
  status visa_batch_status NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (group_id, portal, batch_number)
);

CREATE TRIGGER visa_batches_set_updated_at
  BEFORE UPDATE ON visa_batches
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE TABLE visa_batch_applicants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID NOT NULL REFERENCES visa_batches (id),
  -- Denormalized from visa_batches.group_id (same reasoning as
  -- passport_message_links' own group_id/agent_id denormalization from
  -- telegram_messages): lets the two UNIQUE indexes below be expressed
  -- directly on this table without a join back to visa_batches.
  group_id UUID NOT NULL REFERENCES groups (id),
  passport_identity_id UUID NOT NULL REFERENCES passport_identity (id),
  portal visa_portal NOT NULL,
  position_in_batch INTEGER NOT NULL CHECK (position_in_batch BETWEEN 1 AND 10),
  status visa_batch_applicant_status NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER visa_batch_applicants_set_updated_at
  BEFORE UPDATE ON visa_batch_applicants
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

-- One ACTIVE applicant per batch position -- a cancelled/removed applicant
-- keeps its historical row (and position_in_batch value) forever, but a
-- DIFFERENT, newly-verified applicant may take over that same position in
-- a still-pending batch. Same partial-unique-index idiom as
-- idx_passport_message_links_one_active_canonical.
CREATE UNIQUE INDEX idx_visa_batch_applicants_position_active
  ON visa_batch_applicants (batch_id, position_in_batch)
  WHERE status = 'active';

-- One ACTIVE visa assignment per (group, identity, portal) -- the DB-level
-- backstop against duplicate batch assignment on worker restart or a
-- repeated command, independent of (and in addition to) assignVisaBatch.ts's
-- own application-level find-before-insert check.
CREATE UNIQUE INDEX idx_visa_batch_applicants_one_active_assignment
  ON visa_batch_applicants (group_id, passport_identity_id, portal)
  WHERE status = 'active';

CREATE INDEX idx_visa_batch_applicants_batch ON visa_batch_applicants (batch_id);
