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
--
--    Two kinds of pre-existing object can block this ALTER, because
--    Postgres must re-validate each one against the new type:
--      a) A CHECK constraint enforcing the same four values (stored as
--         status = ANY (ARRAY['queued'::text, ...])).
--      b) A partial/predicate index whose WHERE clause references status
--         (e.g. ... WHERE status = 'queued'::text) — confirmed present in
--         at least one environment as idx_passport_processing_queued.
--    Both hardcode ::text in their stored expression, which has no valid
--    operator once status is an enum — ALTER COLUMN TYPE fails with
--    "operator does not exist: passport_processing_status = text/<>/...".
--    Both are found generically via pg_depend (a real dependency on the
--    status column), not by guessing names, so this also covers any
--    other such object this investigation hasn't specifically seen.
--    Constraints are simply dropped (redundant once status is a real
--    enum — the type itself only ever admits those four values). Indexes
--    hold no data either, so dropping is safe; idx_passport_processing_queued
--    specifically is recreated afterward with its original name and
--    semantics, using an untyped literal so Postgres resolves it against
--    the new enum type instead of ::text. Any other status-dependent
--    index this environment turns out to have is dropped and reported via
--    RAISE NOTICE for manual follow-up, since its intended definition
--    isn't known here.
DO $$
DECLARE
  status_attnum smallint;
  check_constraint RECORD;
  dependent_index RECORD;
  had_queued_index BOOLEAN := false;
BEGIN
  IF (
    SELECT data_type FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'passport_processing' AND column_name = 'status'
  ) = 'text' THEN
    SELECT attnum INTO status_attnum
    FROM pg_attribute
    WHERE attrelid = 'passport_processing'::regclass AND attname = 'status' AND NOT attisdropped;

    FOR check_constraint IN
      SELECT con.conname
      FROM pg_constraint con
      JOIN pg_attribute att
        ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
      WHERE con.contype = 'c'
        AND con.conrelid = 'passport_processing'::regclass
        AND att.attname = 'status'
    LOOP
      EXECUTE format('ALTER TABLE passport_processing DROP CONSTRAINT %I', check_constraint.conname);
    END LOOP;

    FOR dependent_index IN
      SELECT DISTINCT c.relname AS index_name
      FROM pg_depend dep
      JOIN pg_class c ON c.oid = dep.objid AND c.relkind = 'i'
      JOIN pg_index idx ON idx.indexrelid = c.oid
      WHERE dep.refobjid = 'passport_processing'::regclass
        AND dep.refobjsubid = status_attnum
        AND dep.classid = 'pg_class'::regclass
        AND idx.indrelid = 'passport_processing'::regclass
        -- Exclude indexes where status is itself an indexed column (e.g.
        -- idx_passport_processing_status) — those convert automatically
        -- without issue. Only a predicate/expression reference is a problem.
        AND NOT (status_attnum = ANY (idx.indkey::smallint[]))
    LOOP
      IF dependent_index.index_name = 'idx_passport_processing_queued' THEN
        had_queued_index := true;
      ELSE
        RAISE NOTICE 'Dropping index % (predicate/expression references status; not auto-recreated — review and recreate manually if needed)', dependent_index.index_name;
      END IF;
      EXECUTE format('DROP INDEX %I', dependent_index.index_name);
    END LOOP;

    ALTER TABLE passport_processing ALTER COLUMN status DROP DEFAULT;
    ALTER TABLE passport_processing
      ALTER COLUMN status TYPE passport_processing_status
      USING status::passport_processing_status;
    ALTER TABLE passport_processing
      ALTER COLUMN status SET DEFAULT 'queued'::passport_processing_status;

    IF had_queued_index THEN
      CREATE INDEX IF NOT EXISTS idx_passport_processing_queued
        ON passport_processing (queued_at)
        WHERE status = 'queued';
    END IF;
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
