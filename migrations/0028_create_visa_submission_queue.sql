-- VisitSaudi submission queue: durable state for actually submitting a
-- queued batch of visa_batch_applicants to the real VisitSaudi portal.
-- Deliberately separate from visa_batches/visa_batch_applicants (0024) --
-- those tables answer "who is assigned to which batch"; these answer "has
-- this assignment actually been submitted to the portal yet, and what did
-- the portal say" -- same "separate table per distinct purpose" principle
-- already used for sheet_sync_queue (0012) vs sheet_reconciliation_jobs
-- (0022).
CREATE TYPE visa_submission_attempt_status AS ENUM ('pending', 'queued', 'failed');
CREATE TYPE visa_submission_status AS ENUM ('PENDING', 'SUBMITTING', 'SAVED', 'ERROR', 'AMBIGUOUS');
CREATE TYPE visa_sheet_sync_job_status AS ENUM ('pending', 'syncing', 'synced', 'failed');
CREATE TYPE visa_operator_alert_status AS ENUM ('pending', 'sent', 'acknowledged');
CREATE TYPE visa_operator_alert_type AS ENUM ('conflict', 'ambiguous_submission', 'submission_error');
CREATE TYPE visa_submission_review_status AS ENUM ('pending', 'resolved');

-- One row per operator "submit this batch" trigger, created BEFORE any
-- visa_submission_queue row for the batch exists, in its OWN, separately
-- committed transaction (see createSubmissionAttempt in
-- visaSubmissionQueue.repo.ts) -- durable proof the operator's command was
-- received, so a crash between this row and the actual queue creation is
-- interpretable ("attempt exists, queue doesn't" means "queue creation
-- never finished", never "the operator never asked") rather than
-- ambiguous.
CREATE TABLE visa_submission_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID NOT NULL UNIQUE REFERENCES visa_batches (id),
  status visa_submission_attempt_status NOT NULL DEFAULT 'pending',
  requested_by TEXT NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  last_error TEXT
);

-- One row per visa_batch_applicants assignment actually queued for
-- submission. visa_batch_applicant_id is UNIQUE -- the DB-level guarantee
-- against a duplicate queue row for the same assignment, independent of
-- (and in addition to) the application-level all-or-nothing batch-queue
-- creation logic (createQueueForBatch).
CREATE TABLE visa_submission_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  visa_batch_applicant_id UUID NOT NULL UNIQUE REFERENCES visa_batch_applicants (id),
  batch_id UUID NOT NULL REFERENCES visa_batches (id),
  group_id UUID NOT NULL REFERENCES groups (id),
  status visa_submission_status NOT NULL DEFAULT 'PENDING',
  claimed_at TIMESTAMPTZ,
  -- Written at most once, regardless of which side (a finalize call or a
  -- concurrent cancellation) discovers the conflict first -- see
  -- cancelWithConflictCheck's own IS NULL guard in
  -- visaSubmissionQueue.repo.ts.
  conflict_detected_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER visa_submission_queue_set_updated_at
  BEFORE UPDATE ON visa_submission_queue
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_visa_submission_queue_batch ON visa_submission_queue (batch_id);

-- One worker/operator processing a batch at a time -- a DIFFERENT concern
-- from per-applicant claiming above (see visaSubmissionQueueStore.ts's own
-- VisaBatchLockStore doc comment, which this table is the real,
-- DB-backed counterpart to).
CREATE TABLE visa_batch_processing_locks (
  batch_id UUID PRIMARY KEY REFERENCES visa_batches (id),
  locked_by TEXT NOT NULL,
  locked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Durable retry-outbox for writing a submission outcome back to the
-- group's Sheet -- deliberately separate from sheet_sync_queue (0012),
-- same "separate table per distinct purpose" reasoning as
-- sheet_reconciliation_jobs (0022): that table is keyed by
-- telegram_message_id for ordinary append/update syncs, this one is keyed
-- by a visa_submission_queue outcome instead.
CREATE TABLE visa_submission_sheet_sync_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  visa_submission_queue_id UUID NOT NULL REFERENCES visa_submission_queue (id),
  status visa_sheet_sync_job_status NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER visa_submission_sheet_sync_jobs_set_updated_at
  BEFORE UPDATE ON visa_submission_sheet_sync_jobs
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_visa_submission_sheet_sync_jobs_due ON visa_submission_sheet_sync_jobs (next_attempt_at) WHERE status IN ('pending', 'failed');

-- Durable retry-outbox for operator-facing alerts (a detected submission
-- conflict, an AMBIGUOUS outcome, a submission error). event_id is always
-- NOT NULL specifically so UNIQUE(alert_type, event_id) behaves correctly
-- regardless of whether the underlying occurrence is per-applicant
-- (visa_submission_queue.id) or batch-scoped (a freshly minted id) --
-- NULL is never distinct from itself under a standard UNIQUE constraint,
-- so a nullable routing column could never be relied on for this.
CREATE TABLE visa_operator_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL,
  alert_type visa_operator_alert_type NOT NULL,
  batch_id UUID REFERENCES visa_batches (id),
  visa_submission_queue_id UUID REFERENCES visa_submission_queue (id),
  detail TEXT,
  status visa_operator_alert_status NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_visa_operator_alerts_type_event ON visa_operator_alerts (alert_type, event_id);
CREATE INDEX idx_visa_operator_alerts_pending ON visa_operator_alerts (created_at) WHERE status = 'pending';

-- Durable audit of how a detected submission conflict or an AMBIGUOUS
-- outcome was resolved by an operator -- same append-only audit purpose
-- as duplicate_reviews (0018) and passport_identity_events (0019), scoped
-- to this feature's own conflict/ambiguous-resolution decisions.
CREATE TABLE visa_submission_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  visa_submission_queue_id UUID NOT NULL REFERENCES visa_submission_queue (id),
  status visa_submission_review_status NOT NULL DEFAULT 'pending',
  detail TEXT,
  resolved_by TEXT,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_visa_submission_reviews_pending ON visa_submission_reviews (created_at) WHERE status = 'pending';
