-- Durable "a Sheet delete/reassign is owed" ledger — closes the crash
-- window every prior delete/reassign path shared: DB transaction commits,
-- then a SEPARATE, un-queued Sheets call runs; if that call fails or the
-- process dies in between, nothing durable recorded that the Sheet side
-- was still owed, and every existing idempotency guard (checking DOMAIN
-- state, e.g. findActiveCanonicalLink) treats "DB already reflects the
-- new state" as "fully done", silently skipping the Sheet fixup forever.
--
-- Deliberately a SEPARATE table from sheet_sync_queue (0012), not an
-- extension of it: sheet_sync_queue's whole shape (one row per
-- telegram_message_id, UNIQUE-guarded, always an upsert-by-own-id) is for
-- ordinary appends/updates and is already correctly crash-safe for that —
-- mixing a delete/reassign lifecycle into it would risk destabilizing
-- upsertRowInSheet.ts's own call site and its existing, already-passing
-- test suite. This table and sheet_sync_queue never reference each other.
--
-- Every domain transaction that determines a Sheet delete/reassign will be
-- needed (retireCanonicalAndPromoteReplacement, promoteReplacementAndRelocateLink,
-- mergeIdentitiesTransaction, applySplitTransaction) INSERTs exactly one
-- row here, in the SAME BEGIN/COMMIT as the domain change itself — so a
-- crash right after COMMIT can never lose the fact that a Sheet fixup is
-- still owed: either both the domain change and this row exist, or
-- neither does.
--
-- expected_old_canonical_telegram_message_id is the ONLY thing that must
-- be captured historically: which message id currently occupies this
-- (identity, group)'s row in the Sheet, so the worker can LOCATE it via
-- column M (Google Sheets has no native concept of identity/group). The
-- worker deliberately does NOT store or trust "what it should become" —
-- see reconcileSheetRow.ts's own doc comment for why re-deriving the
-- target fresh at processing time (rather than replaying a captured one)
-- makes recovery correct even when multiple operations stack up on the
-- same (identity, group) before either job has run.
CREATE TYPE sheet_reconciliation_status AS ENUM ('pending', 'processing', 'done', 'failed');

CREATE TABLE sheet_reconciliation_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  passport_identity_id UUID NOT NULL REFERENCES passport_identity (id),
  group_id UUID NOT NULL REFERENCES groups (id),
  expected_old_canonical_telegram_message_id UUID NOT NULL REFERENCES telegram_messages (id),
  -- Traceability/debugging only — the worker's own decision logic never
  -- reads this, it always re-resolves fresh from Postgres.
  source_operation TEXT NOT NULL,
  source_event_id UUID REFERENCES passport_identity_events (id),
  status sheet_reconciliation_status NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE TRIGGER sheet_reconciliation_jobs_set_updated_at
  BEFORE UPDATE ON sheet_reconciliation_jobs
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

-- No uniqueness on (passport_identity_id, group_id): multiple stacked jobs
-- for the SAME (identity, group), each anchored at a different historical
-- old id, are expected and safe — the worker's fresh-target re-resolution
-- makes them converge to the correct end state regardless of processing
-- order (see reconcileSheetRow.ts).
CREATE INDEX idx_sheet_reconciliation_jobs_due ON sheet_reconciliation_jobs (next_attempt_at) WHERE status IN ('pending', 'failed');
CREATE INDEX idx_sheet_reconciliation_jobs_identity_group ON sheet_reconciliation_jobs (passport_identity_id, group_id);
