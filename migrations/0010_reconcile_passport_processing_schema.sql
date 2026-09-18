-- Reconciliation migration.
--
-- On at least one deployed environment, schema_migrations records
-- 0008_create_passport_processing.sql as applied, but the live
-- passport_processing table does not actually match what that file
-- defines: it is missing created_at entirely, and status was created as
-- plain text instead of the passport_processing_status enum. Our migration
-- runner tracks migrations by filename only (not by content hash), so it
-- has no way to detect or re-run a file whose SQL never actually executed
-- there; 0008 itself is also not touched here, since it is already
-- recorded as applied and must stay that way.
--
-- Every step below is additive/idempotent: guarded so it's a safe no-op on
-- an environment where 0008 already ran correctly, and a real (non-
-- destructive) fix on one where it didn't. No DROP of data, no rewrite of
-- existing column values except the one explicit, evidence-based backfill.

-- 1. Ensure the enum type exists.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'passport_processing_status') THEN
    CREATE TYPE passport_processing_status AS ENUM ('queued', 'processing', 'completed', 'failed');
  END IF;
END $$;

-- 2. Add created_at if missing. Existing rows are backfilled from
--    queued_at — the closest real record of when each row was actually
--    created — rather than now(), which would fabricate a false creation
--    time for pre-existing rows.
ALTER TABLE passport_processing ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;

UPDATE passport_processing
SET created_at = queued_at
WHERE created_at IS NULL;

ALTER TABLE passport_processing ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE passport_processing ALTER COLUMN created_at SET NOT NULL;

-- 3. Convert status to the enum type if it is still plain text. The USING
--    cast fails loudly (rolling back this whole migration, since the
--    runner wraps each file in a transaction) rather than corrupting data
--    if some row somehow holds a value outside the four known statuses.
DO $$
BEGIN
  IF (
    SELECT data_type FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'passport_processing' AND column_name = 'status'
  ) = 'text' THEN
    ALTER TABLE passport_processing ALTER COLUMN status DROP DEFAULT;
    ALTER TABLE passport_processing
      ALTER COLUMN status TYPE passport_processing_status
      USING status::passport_processing_status;
    ALTER TABLE passport_processing
      ALTER COLUMN status SET DEFAULT 'queued'::passport_processing_status;
  END IF;
END $$;

-- 4. Ensure the updated_at trigger exists (safe to drop/recreate — a
--    trigger definition holds no data).
DROP TRIGGER IF EXISTS passport_processing_set_updated_at ON passport_processing;
CREATE TRIGGER passport_processing_set_updated_at
  BEFORE UPDATE ON passport_processing
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

-- 5. Ensure the status index exists.
CREATE INDEX IF NOT EXISTS idx_passport_processing_status ON passport_processing (status);
