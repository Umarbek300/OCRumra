import type { PoolClient } from 'pg';
import { pool } from '../pool.js';
import type { VisaBatchApplicantStatus } from '../../visa/types.js';

export type VisaSubmissionAttemptStatus = 'pending' | 'queued' | 'failed';
export type VisaSubmissionStatus = 'PENDING' | 'SUBMITTING' | 'SAVED' | 'ERROR' | 'AMBIGUOUS';

export interface VisaSubmissionAttemptRecord {
  id: string;
  batchId: string;
  status: VisaSubmissionAttemptStatus;
  requestedBy: string;
  requestedAt: string;
  completedAt: string | null;
  lastError: string | null;
}

interface VisaSubmissionAttemptRow {
  id: string;
  batch_id: string;
  status: VisaSubmissionAttemptStatus;
  requested_by: string;
  requested_at: string;
  completed_at: string | null;
  last_error: string | null;
}

function mapAttemptRow(row: VisaSubmissionAttemptRow): VisaSubmissionAttemptRecord {
  return {
    id: row.id,
    batchId: row.batch_id,
    status: row.status,
    requestedBy: row.requested_by,
    requestedAt: row.requested_at,
    completedAt: row.completed_at,
    lastError: row.last_error,
  };
}

const ATTEMPT_COLUMNS = 'id, batch_id, status, requested_by, requested_at, completed_at, last_error';

export interface VisaSubmissionQueueRecord {
  id: string;
  visaBatchApplicantId: string;
  batchId: string;
  groupId: string;
  status: VisaSubmissionStatus;
  claimedAt: string | null;
  conflictDetectedAt: string | null;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

interface VisaSubmissionQueueRow {
  id: string;
  visa_batch_applicant_id: string;
  batch_id: string;
  group_id: string;
  status: VisaSubmissionStatus;
  claimed_at: string | null;
  conflict_detected_at: string | null;
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

function mapQueueRow(row: VisaSubmissionQueueRow): VisaSubmissionQueueRecord {
  return {
    id: row.id,
    visaBatchApplicantId: row.visa_batch_applicant_id,
    batchId: row.batch_id,
    groupId: row.group_id,
    status: row.status,
    claimedAt: row.claimed_at,
    conflictDetectedAt: row.conflict_detected_at,
    attempts: row.attempts,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const QUEUE_COLUMNS =
  'id, visa_batch_applicant_id, batch_id, group_id, status, claimed_at, conflict_detected_at, attempts, last_error, created_at, updated_at';

/**
 * Durable proof that an operator's "submit this batch" command was
 * received, written BEFORE any visa_submission_queue row exists for the
 * batch -- see migrations/0028_create_visa_submission_queue.sql's own doc
 * comment. batch_id is UNIQUE: a second attempt for the same batch
 * returns the EXISTING row (never a duplicate) -- same
 * ON-CONFLICT-DO-NOTHING-plus-fallback-read idiom used throughout this
 * schema (e.g. createPassportIdentity).
 */
export async function createSubmissionAttempt(batchId: string, requestedBy: string): Promise<VisaSubmissionAttemptRecord> {
  const { rows } = await pool.query<VisaSubmissionAttemptRow>(
    `INSERT INTO visa_submission_attempts (batch_id, requested_by)
     VALUES ($1, $2)
     ON CONFLICT (batch_id) DO NOTHING
     RETURNING ${ATTEMPT_COLUMNS}`,
    [batchId, requestedBy],
  );
  const row = rows[0];
  if (row) {
    return mapAttemptRow(row);
  }
  const { rows: existingRows } = await pool.query<VisaSubmissionAttemptRow>(
    `SELECT ${ATTEMPT_COLUMNS} FROM visa_submission_attempts WHERE batch_id = $1`,
    [batchId],
  );
  const existing = existingRows[0];
  if (!existing) {
    throw new Error(`createSubmissionAttempt: lost the insert race for batch ${batchId} but no existing row was found`);
  }
  return mapAttemptRow(existing);
}

/**
 * Atomically creates one visa_submission_queue row for every currently
 * ACTIVE visa_batch_applicants row in this batch -- all-or-nothing, in one
 * transaction -- and marks the batch's own submission attempt 'queued' in
 * the SAME transaction.
 *
 * The FIRST statement locks the batch's own visa_submission_attempts row
 * (FOR UPDATE) -- that row is UNIQUE per batch_id, so this serializes
 * every concurrent caller for the SAME batch (e.g. an operator double-
 * clicking a Telegram command, or two workers racing) onto one at a time:
 * a second, concurrent call blocks here until the first commits or rolls
 * back, then re-reads an up-to-date "already queued?" check below --
 * never racing past it and both attempting to INSERT the same
 * visa_batch_applicant_id rows, which would otherwise raise a real
 * unique_violation (that INSERT has no ON CONFLICT guard) instead of
 * gracefully returning null.
 *
 * The active-applicant list is read with FOR SHARE right after that --
 * never as a separate pre-check before this transaction opens -- so a
 * concurrent cancellation (which takes FOR UPDATE on the same
 * visa_batch_applicants rows, see cancelWithConflictCheck below, in the
 * SAME lock order: visa_batch_applicants before visa_submission_queue)
 * cannot slip in between this read and the queue-row inserts without
 * this transaction waiting for it (or vice versa), never deadlocking.
 *
 * Returns null if a visa_submission_queue row already exists for this
 * batch (e.g. this attempt is being retried after it already succeeded
 * once, including when retried concurrently) -- never creates a second,
 * duplicate set of queue rows. The caller (a future operator-triggered
 * command) is expected to treat null as "already queued", not as a
 * failure.
 */
export async function createQueueForBatch(batchId: string, attemptId: string): Promise<VisaSubmissionQueueRecord[] | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Serializes concurrent callers for the SAME batch: this attempt row is
    // UNIQUE per batch_id (createSubmissionAttempt), so locking it FIRST
    // means a second, concurrent createQueueForBatch call for the same
    // batch blocks here until the first transaction commits or rolls back,
    // instead of both racing past the "already queued" check below and
    // both attempting to INSERT the same visa_batch_applicant_id rows --
    // which would otherwise raise a real unique_violation (no ON CONFLICT
    // guard on that INSERT) rather than gracefully returning null.
    await client.query(`SELECT id FROM visa_submission_attempts WHERE id = $1 FOR UPDATE`, [attemptId]);

    const { rows: existing } = await client.query<{ id: string }>(`SELECT id FROM visa_submission_queue WHERE batch_id = $1 LIMIT 1`, [
      batchId,
    ]);
    if (existing.length > 0) {
      await client.query('COMMIT');
      return null;
    }

    const { rows: applicantRows } = await client.query<{ id: string; group_id: string }>(
      `SELECT id, group_id FROM visa_batch_applicants WHERE batch_id = $1 AND status = 'active' FOR SHARE`,
      [batchId],
    );

    const created: VisaSubmissionQueueRecord[] = [];
    for (const applicant of applicantRows) {
      const { rows } = await client.query<VisaSubmissionQueueRow>(
        `INSERT INTO visa_submission_queue (visa_batch_applicant_id, batch_id, group_id)
         VALUES ($1, $2, $3)
         RETURNING ${QUEUE_COLUMNS}`,
        [applicant.id, batchId, applicant.group_id],
      );
      const row = rows[0];
      if (!row) {
        throw new Error(`createQueueForBatch: insert unexpectedly returned no row for applicant ${applicant.id}`);
      }
      created.push(mapQueueRow(row));
    }

    await client.query(`UPDATE visa_submission_attempts SET status = 'queued', completed_at = now() WHERE id = $1 AND status = 'pending'`, [
      attemptId,
    ]);

    await client.query('COMMIT');
    return created;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function findQueueRecordById(queueId: string): Promise<VisaSubmissionQueueRecord | null> {
  const { rows } = await pool.query<VisaSubmissionQueueRow>(`SELECT ${QUEUE_COLUMNS} FROM visa_submission_queue WHERE id = $1`, [queueId]);
  const row = rows[0];
  return row ? mapQueueRow(row) : null;
}

export async function findQueueRecordByApplicantId(visaBatchApplicantId: string): Promise<VisaSubmissionQueueRecord | null> {
  const { rows } = await pool.query<VisaSubmissionQueueRow>(
    `SELECT ${QUEUE_COLUMNS} FROM visa_submission_queue WHERE visa_batch_applicant_id = $1`,
    [visaBatchApplicantId],
  );
  const row = rows[0];
  return row ? mapQueueRow(row) : null;
}

/**
 * Inserts a single queue row for one already-resolved
 * visa_batch_applicant_id. A SECONDARY creation path -- the PRIMARY entry
 * point for queuing a batch for submission is createQueueForBatch above
 * (atomic, whole-batch). This exists only so a VisaSubmissionQueueStore
 * adapter (visaSubmissionQueuePostgresStore.ts) can satisfy that
 * interface's own per-applicant createRecord contract. Idempotent via the
 * same visa_batch_applicant_id UNIQUE constraint createQueueForBatch
 * relies on -- returns the EXISTING row rather than erroring if one
 * already exists.
 */
export async function createSingleQueueRecord(
  visaBatchApplicantId: string,
  batchId: string,
  groupId: string,
): Promise<VisaSubmissionQueueRecord> {
  const { rows } = await pool.query<VisaSubmissionQueueRow>(
    `INSERT INTO visa_submission_queue (visa_batch_applicant_id, batch_id, group_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (visa_batch_applicant_id) DO NOTHING
     RETURNING ${QUEUE_COLUMNS}`,
    [visaBatchApplicantId, batchId, groupId],
  );
  const row = rows[0];
  if (row) {
    return mapQueueRow(row);
  }
  const existing = await findQueueRecordByApplicantId(visaBatchApplicantId);
  if (!existing) {
    throw new Error(`createSingleQueueRecord: lost the insert race for applicant ${visaBatchApplicantId} but no existing row was found`);
  }
  return existing;
}

export type AtomicTransitionResult =
  | { outcome: 'transitioned'; record: VisaSubmissionQueueRecord }
  | { outcome: 'current-status-mismatch'; record: VisaSubmissionQueueRecord }
  | { outcome: 'record-not-found' };

/**
 * Generic atomic status transition -- the one primitive a
 * VisaSubmissionQueueStore adapter needs to satisfy its own
 * atomicTransition contract (any from/to pair; the orchestrator's own
 * canTransition already validated the pair BEFORE this is ever called, so
 * this function itself enforces nothing about which transitions are
 * legal). claimForSubmission/finalizeSubmission above remain the
 * PREFERRED, narrower, self-documenting functions for the two real
 * transition shapes this feature actually uses -- this generic version
 * exists only for the Store adapter's sake. This is the function the
 * REAL production claim path actually runs through (claimApplicantForSubmission
 * -> requestTransition -> store.atomicTransition -> here), NOT
 * claimForSubmission above, which currently has no production caller.
 *
 * The PENDING -> SUBMITTING (claim) direction is delegated entirely to
 * claimTransitionToSubmitting below -- see that function's own doc comment
 * for why a single-statement UPDATE (even with an EXISTS guard -- an
 * earlier version of this function used exactly that, and Package 5.4.2's
 * own two-real-connection test proved it insufficient) cannot close the
 * cancellation/claim race. Every OTHER transition (SUBMITTING ->
 * {SAVED|ERROR|AMBIGUOUS}, the only other pairs ALLOWED_TRANSITIONS
 * permits) stays exactly the single-statement shape below, unconditional on
 * applicant status -- a cancellation discovered mid-flight is reported via
 * cancelWithConflictCheck's own conflict alert, never by blocking finalize.
 *
 * claimed_at is set to now() when transitioning TO 'SUBMITTING', and
 * cleared otherwise -- same convention as claimForSubmission/
 * finalizeSubmission. attempts increments only on a transition INTO
 * 'SUBMITTING', matching claimForSubmission's own behavior. (In practice,
 * for THIS branch, nextStatus is never 'SUBMITTING' -- that case is routed
 * to claimTransitionToSubmitting above -- so these CASE expressions always
 * take their ELSE arm here; left as-is, unchanged, rather than simplified,
 * to keep this round's diff minimal and focused on removing the EXISTS
 * clause specifically.)
 */
export async function atomicTransition(
  queueId: string,
  expectedCurrentStatus: VisaSubmissionStatus,
  nextStatus: VisaSubmissionStatus,
): Promise<AtomicTransitionResult> {
  if (nextStatus === 'SUBMITTING') {
    return claimTransitionToSubmitting(queueId, expectedCurrentStatus);
  }

  const { rows } = await pool.query<VisaSubmissionQueueRow>(
    `UPDATE visa_submission_queue
     SET status = $3::visa_submission_status,
         claimed_at = CASE WHEN $3::visa_submission_status = 'SUBMITTING' THEN now() ELSE NULL END,
         attempts = CASE WHEN $3::visa_submission_status = 'SUBMITTING' THEN attempts + 1 ELSE attempts END
     WHERE id = $1 AND status = $2
     RETURNING ${QUEUE_COLUMNS}`,
    [queueId, expectedCurrentStatus, nextStatus],
  );
  const updated = rows[0];
  if (updated) {
    return { outcome: 'transitioned', record: mapQueueRow(updated) };
  }

  const current = await findQueueRecordById(queueId);
  if (!current) {
    return { outcome: 'record-not-found' };
  }
  return { outcome: 'current-status-mismatch', record: current };
}

/**
 * The PENDING -> SUBMITTING (claim) direction's own transactional
 * implementation -- see Package 5.4.4's own lock-order audit and 5.4.3's
 * mechanism analysis for why a plain single-statement UPDATE with an
 * EXISTS guard (this function's own earlier, Package 5.4.2 shape) cannot
 * close the cancellation/claim race under genuine PostgreSQL concurrency:
 * an EXISTS subquery reading a DIFFERENT table than the one this UPDATE
 * blocks on evaluates against a STALE, per-statement snapshot once
 * unblocked, confirmed empirically (Package 5.4.2) via two real,
 * independent PostgreSQL connections.
 *
 * This function instead takes applicant lock itself, DIRECTLY, as its own
 * first statement -- the SAME lock order cancelWithConflictCheck already
 * uses and must never be reversed against (visa_batch_applicants FIRST,
 * THEN visa_submission_queue). Because PostgreSQL's row-locking SELECT
 * (FOR SHARE/UPDATE/...) re-reads the LATEST committed version of the row
 * it waited on once unblocked (not a stale snapshot -- this is the
 * documented exception a plain cross-table EXISTS subquery does not get),
 * a concurrent cancellation is correctly observed however the two
 * transactions interleave: cancelWithConflictCheck's own `FOR UPDATE`
 * conflicts with this function's `FOR SHARE` on the exact same row, so one
 * side always waits for the other to fully commit before proceeding.
 *
 * A row rejected solely because the applicant is missing or inactive is
 * reported identically to a genuine status mismatch
 * ('current-status-mismatch') -- same deliberate simplification the
 * EXISTS-based branch above already documented: every caller already
 * treats any non-'transitioned' outcome the same way ("do not proceed to
 * automation"), so no new AtomicTransitionResult outcome is introduced.
 */
async function claimTransitionToSubmitting(queueId: string, expectedCurrentStatus: VisaSubmissionStatus): Promise<AtomicTransitionResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: queueLookupRows } = await client.query<{ visa_batch_applicant_id: string }>(
      `SELECT visa_batch_applicant_id FROM visa_submission_queue WHERE id = $1`,
      [queueId],
    );
    const applicantId = queueLookupRows[0]?.visa_batch_applicant_id;

    let applicantIsActive = false;
    if (applicantId) {
      const { rows: applicantRows } = await client.query<{ status: VisaBatchApplicantStatus }>(
        `SELECT status FROM visa_batch_applicants WHERE id = $1 FOR SHARE`,
        [applicantId],
      );
      applicantIsActive = applicantRows[0]?.status === 'active';
    }

    if (!applicantIsActive) {
      await client.query('COMMIT');
      const current = await findQueueRecordById(queueId);
      return current ? { outcome: 'current-status-mismatch', record: current } : { outcome: 'record-not-found' };
    }

    const { rows: updatedRows } = await client.query<VisaSubmissionQueueRow>(
      `UPDATE visa_submission_queue
       SET status = 'SUBMITTING', claimed_at = now(), attempts = attempts + 1
       WHERE id = $1 AND status = $2
       RETURNING ${QUEUE_COLUMNS}`,
      [queueId, expectedCurrentStatus],
    );
    const updated = updatedRows[0];
    await client.query('COMMIT');

    if (updated) {
      return { outcome: 'transitioned', record: mapQueueRow(updated) };
    }
    const current = await findQueueRecordById(queueId);
    return current ? { outcome: 'current-status-mismatch', record: current } : { outcome: 'record-not-found' };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Per-status row counts for one batch -- a pure, read-only aggregate, the
 * basis for an operator-facing status view (see
 * visaSubmissionStatusCommand.ts). Always returns all five statuses, 0
 * for any with no rows, never an absent key.
 */
export async function countQueueStatusesForBatch(batchId: string): Promise<Record<VisaSubmissionStatus, number>> {
  const { rows } = await pool.query<{ status: VisaSubmissionStatus; count: string }>(
    `SELECT status, count(*)::text AS count FROM visa_submission_queue WHERE batch_id = $1 GROUP BY status`,
    [batchId],
  );
  const counts: Record<VisaSubmissionStatus, number> = { PENDING: 0, SUBMITTING: 0, SAVED: 0, ERROR: 0, AMBIGUOUS: 0 };
  for (const row of rows) {
    counts[row.status] = Number(row.count);
  }
  return counts;
}

/** How many queue rows in this batch have a detected-but-unresolved cancellation conflict (see cancelWithConflictCheck). Read-only. */
export async function countUnresolvedConflictsForBatch(batchId: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM visa_submission_queue WHERE batch_id = $1 AND conflict_detected_at IS NOT NULL`,
    [batchId],
  );
  return Number(rows[0]?.count ?? '0');
}

/**
 * Package 5.10's audit finding 5 / Package 5.11's Part 1: how many PENDING
 * queue rows in this batch belong to an applicant that is no longer
 * active (cancelled/removed) -- a dead row nothing will ever claim or
 * resubmit, invisible to findAttentionNeededForBatch (which deliberately
 * excludes all PENDING rows, by design, for a different reason) and
 * indistinguishable from a live PENDING row in countQueueStatusesForBatch's
 * own plain per-status count. Purely a read-only aggregate -- never
 * touches visa_submission_queue.status or visa_batch_applicants.status.
 */
export async function countPendingWithInactiveApplicantForBatch(batchId: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM visa_submission_queue q
     JOIN visa_batch_applicants a ON a.id = q.visa_batch_applicant_id
     WHERE q.batch_id = $1 AND q.status = 'PENDING' AND a.status <> 'active'`,
    [batchId],
  );
  return Number(rows[0]?.count ?? '0');
}

/** Every queue row currently SUBMITTING whose claimed_at is older than staleAfterMs, as of the database's own clock. */
export async function findStaleSubmitting(staleAfterMs: number): Promise<VisaSubmissionQueueRecord[]> {
  const { rows } = await pool.query<VisaSubmissionQueueRow>(
    `SELECT ${QUEUE_COLUMNS} FROM visa_submission_queue
     WHERE status = 'SUBMITTING' AND claimed_at < now() - ($1::double precision * interval '1 millisecond')`,
    [staleAfterMs],
  );
  return rows.map(mapQueueRow);
}

/**
 * Attempts to claim exactly one queue row for submission processing
 * (PENDING -> SUBMITTING). Package 5.9: delegates to atomicTransition (and,
 * through it, to claimTransitionToSubmitting's own transaction, which takes
 * the applicant's FOR SHARE lock first) instead of running its own
 * standalone UPDATE ... WHERE status = 'PENDING' -- the signature, return
 * type, and null-vs-record semantics are unchanged, but a row whose
 * applicant is no longer active is now correctly left unclaimed (the same
 * lock-order-proven protection claimApplicantForSubmission's own
 * requestTransition path already has) instead of the old behavior, which
 * had no applicant-active check at all. No production caller exists for
 * this function today (see atomicTransition's own doc comment for the
 * function the real production claim path actually runs through); this
 * change exists to remove that latent gap before any future caller is
 * wired to it.
 */
export async function claimForSubmission(queueId: string): Promise<VisaSubmissionQueueRecord | null> {
  const result = await atomicTransition(queueId, 'PENDING', 'SUBMITTING');
  return result.outcome === 'transitioned' ? result.record : null;
}

/**
 * Transitions a claimed (SUBMITTING) queue row to its final outcome.
 * Single atomic UPDATE, same convention as claimForSubmission above --
 * the caller decides SAVED vs ERROR vs AMBIGUOUS based on what the actual
 * portal-automation step observed (out of scope here).
 */
export async function finalizeSubmission(
  queueId: string,
  outcome: Extract<VisaSubmissionStatus, 'SAVED' | 'ERROR' | 'AMBIGUOUS'>,
  errorMessage: string | null = null,
): Promise<VisaSubmissionQueueRecord | null> {
  const { rows } = await pool.query<VisaSubmissionQueueRow>(
    `UPDATE visa_submission_queue
     SET status = $2, claimed_at = NULL, last_error = $3
     WHERE id = $1 AND status = 'SUBMITTING'
     RETURNING ${QUEUE_COLUMNS}`,
    [queueId, outcome, errorMessage],
  );
  const row = rows[0];
  return row ? mapQueueRow(row) : null;
}

export interface VisaBatchProcessingLockRecord {
  batchId: string;
  lockedBy: string;
  lockedAt: string;
}

interface VisaBatchProcessingLockRow {
  batch_id: string;
  locked_by: string;
  locked_at: string;
}

function mapLockRow(row: VisaBatchProcessingLockRow): VisaBatchProcessingLockRecord {
  return { batchId: row.batch_id, lockedBy: row.locked_by, lockedAt: row.locked_at };
}

/**
 * Acquires the one processing lock for a batch -- backed by
 * visa_batch_processing_locks' own PRIMARY KEY (batch_id), the real,
 * cross-process DB constraint the in-memory VisaBatchLockStore fake
 * (visaSubmissionQueueStore.ts) explicitly disclaims being equivalent to.
 * Returns null (never throws) when another worker already holds it.
 */
export async function acquireBatchProcessingLock(batchId: string, lockedBy: string): Promise<VisaBatchProcessingLockRecord | null> {
  const { rows } = await pool.query<VisaBatchProcessingLockRow>(
    `INSERT INTO visa_batch_processing_locks (batch_id, locked_by)
     VALUES ($1, $2)
     ON CONFLICT (batch_id) DO NOTHING
     RETURNING batch_id, locked_by, locked_at`,
    [batchId, lockedBy],
  );
  const row = rows[0];
  return row ? mapLockRow(row) : null;
}

export async function findBatchProcessingLock(batchId: string): Promise<VisaBatchProcessingLockRecord | null> {
  const { rows } = await pool.query<VisaBatchProcessingLockRow>(
    `SELECT batch_id, locked_by, locked_at FROM visa_batch_processing_locks WHERE batch_id = $1`,
    [batchId],
  );
  const row = rows[0];
  return row ? mapLockRow(row) : null;
}

export type ReleaseBatchProcessingLockOutcome = 'released' | 'not-holder' | 'not-locked';

export async function releaseBatchProcessingLock(batchId: string, lockedBy: string): Promise<ReleaseBatchProcessingLockOutcome> {
  const { rows } = await pool.query<{ batch_id: string }>(
    `DELETE FROM visa_batch_processing_locks WHERE batch_id = $1 AND locked_by = $2 RETURNING batch_id`,
    [batchId, lockedBy],
  );
  if (rows[0]) {
    return 'released';
  }
  const { rows: existing } = await pool.query<{ batch_id: string }>(`SELECT batch_id FROM visa_batch_processing_locks WHERE batch_id = $1`, [
    batchId,
  ]);
  return existing[0] ? 'not-holder' : 'not-locked';
}

export async function findStaleBatchProcessingLocks(staleAfterMs: number): Promise<VisaBatchProcessingLockRecord[]> {
  const { rows } = await pool.query<VisaBatchProcessingLockRow>(
    `SELECT batch_id, locked_by, locked_at FROM visa_batch_processing_locks
     WHERE locked_at < now() - ($1::double precision * interval '1 millisecond')`,
    [staleAfterMs],
  );
  return rows.map(mapLockRow);
}

export type ForceReleaseBatchProcessingLockOutcome = 'released' | 'not-matched';

/**
 * Package 5.22: used only by stale-lock recovery -- force-clears a lock
 * presumed abandoned by a crashed worker, but ONLY the EXACT lock
 * findStaleBatchProcessingLocks itself observed (batch_id + locked_by +
 * locked_at), never a lock that happens to sit at this batch_id NOW. Fixes
 * Package 5.21's own audit finding: the previous version's
 * `DELETE ... WHERE batch_id = $1` was unconditional on locked_by/locked_at,
 * so a lock that was legitimately released and re-acquired by a DIFFERENT
 * worker in the gap between the staleness SELECT and this DELETE would be
 * force-cleared too -- deleting a lock that was never actually stale.
 *
 * Deliberately NOT an exact `locked_at = $3` equality: node-postgres parses
 * `timestamptz` into a JS Date, which only has millisecond precision,
 * while the column itself has microsecond precision (confirmed empirically
 * -- pg's own TIMESTAMPTZ parser truncates e.g. '...123456+00' to
 * '...123Z'). An exact equality using a millisecond-truncated value would
 * falsely NOT match the very same, unchanged row whenever its true
 * microsecond component is non-zero -- the common case for a `now()`-
 * populated column. Instead, this matches a one-millisecond HALF-OPEN
 * window starting at the given millisecond value: `.getTime()` always
 * truncates DOWN to the start of its millisecond, so the row's true,
 * full-precision timestamp is mathematically guaranteed to fall inside
 * [lockedAtMs, lockedAtMs + 1ms) if and only if it is the SAME lock --
 * any genuinely different acquisition (even moments later) falls outside
 * this tight window in practice.
 *
 * Zero rows deleted is NOT treated as a failure -- it means the lock
 * already changed (released and/or re-acquired) by the time this ran, so
 * the current lock (whatever it now is) is correctly left untouched. The
 * caller (recoverStaleBatchLocks) is responsible for interpreting
 * 'not-matched' as exactly that, never as an error.
 *
 * Deliberately NOT a heartbeat/renewal mechanism -- a legitimately slow
 * (not crashed) worker whose own processing exceeds staleAfterMs has no
 * way to refresh locked_at and avoid being targeted by this recovery sweep
 * in the first place; this package documents that as a SEPARATE, still-
 * open risk (see Package 5.21's own audit finding 4) rather than
 * attempting to solve it here.
 */
export async function forceReleaseBatchProcessingLock(
  batchId: string,
  lockedBy: string,
  lockedAtMs: number,
): Promise<ForceReleaseBatchProcessingLockOutcome> {
  const { rows } = await pool.query<{ batch_id: string }>(
    `DELETE FROM visa_batch_processing_locks
     WHERE batch_id = $1
       AND locked_by = $2
       AND locked_at >= to_timestamp($3::double precision / 1000.0)
       AND locked_at < to_timestamp(($3::double precision + 1) / 1000.0)
     RETURNING batch_id`,
    [batchId, lockedBy, lockedAtMs],
  );
  return rows[0] ? 'released' : 'not-matched';
}

/**
 * Idempotently records a durable operator alert for a detected submission
 * conflict, inside the SAME transaction/client as the conflict detection
 * itself (see cancelWithConflictCheck below) -- the queue row's own id
 * doubles as event_id: conflict_detected_at is set at most once per row
 * (its own IS NULL guard), so the row's id is already a reliable,
 * always-NOT-NULL "this exact conflict occurrence" identity, with no need
 * to mint a separate one. UNIQUE(alert_type, event_id) makes a repeated
 * call (e.g. if this were ever retried) a safe no-op, never a duplicate
 * alert.
 */
async function recordConflictAlertWithClient(
  client: PoolClient,
  queueId: string,
  batchId: string,
  detail: string | null,
): Promise<void> {
  await client.query(
    `INSERT INTO visa_operator_alerts (event_id, alert_type, batch_id, visa_submission_queue_id, detail)
     VALUES ($1, 'conflict', $2, $1, $3)
     ON CONFLICT (alert_type, event_id) DO NOTHING`,
    [queueId, batchId, detail],
  );
}

export interface RetireApplicantWithConflictCheckResult {
  /** false when the applicant was already cancelled/removed -- a safe no-op, not an error. */
  retired: boolean;
  /** true when a SUBMITTING queue row was found for this applicant -- see this function's own doc comment. */
  conflictDetected: boolean;
}

/**
 * The per-applicant core cancelWithConflictCheck (below) itself now uses --
 * factored out so OTHER already-open transactions (identity merge, group/
 * identity state-change retirement in visaBatches.repo.ts) can reuse the
 * IDENTICAL lock order and conflict-detection/alert behavior without
 * nesting a second transaction inside their own. Takes an existing client
 * and never opens or closes a transaction itself -- no BEGIN, COMMIT,
 * ROLLBACK, or client.release() -- the CALLER's own transaction boundary
 * governs entirely, exactly like updateActiveAssignmentsStatusWithClient/
 * insertReconciliationJobWithClient/recordConflictAlertWithClient already
 * do in this codebase.
 *
 * Lock order is fixed and must NEVER be reversed: visa_batch_applicants
 * FIRST (FOR UPDATE), THEN visa_submission_queue (FOR UPDATE) -- the SAME
 * order createQueueForBatch's own FOR SHARE read uses, so a concurrent
 * cancellation/retirement and queue-creation/claim can never deadlock
 * against each other (see claimTransitionToSubmitting's own doc comment
 * for why this exact order is also what makes a concurrent claim correctly
 * observe a retirement, in either interleaving).
 *
 * If the queue row is currently SUBMITTING, this is a conflict: a portal
 * submission may already be in flight for an applicant now being
 * retired. conflict_detected_at is set at most once (its own IS NULL
 * guard) regardless of which side notices first, and a durable operator
 * alert is recorded in the SAME transaction (recordConflictAlertWithClient)
 * so a human is notified immediately rather than waiting for
 * recoverStaleSubmittingToAmbiguous's own stale-timeout sweep. The
 * submission's own status is deliberately left untouched (still
 * SUBMITTING) -- it is NEVER reset to PENDING here, so a conflict can
 * never trigger an automatic resubmission against an ambiguous portal
 * outcome, and a conflict is NEVER a reason to skip retiring the applicant
 * itself (the retirement always proceeds regardless). If the queue row is
 * PENDING, SAVED, ERROR, AMBIGUOUS, or does not exist at all, there is
 * nothing in flight to flag -- the applicant is retired with no alert,
 * exactly as before. A PENDING row is deliberately left untouched too
 * (never cancelled/deleted here): it simply becomes unclaimable once the
 * applicant is no longer active, via claimTransitionToSubmitting's own,
 * already-proven applicant-status check.
 *
 * `alertDetail` lets each caller distinguish, in the alert's own free-text
 * detail column (visa_operator_alerts has no separate "source operation"
 * column), WHICH operation triggered this -- cancellation, group/identity
 * state change, or identity merge -- without any schema change.
 */
export async function retireApplicantWithConflictCheckWithClient(
  client: PoolClient,
  applicantId: string,
  newStatus: Extract<VisaBatchApplicantStatus, 'cancelled' | 'removed'>,
  alertDetail: string,
): Promise<RetireApplicantWithConflictCheckResult> {
  const { rows: applicantRows } = await client.query<{ id: string; status: VisaBatchApplicantStatus; batch_id: string }>(
    `SELECT id, status, batch_id FROM visa_batch_applicants WHERE id = $1 FOR UPDATE`,
    [applicantId],
  );
  const applicant = applicantRows[0];
  if (!applicant) {
    throw new Error(`retireApplicantWithConflictCheckWithClient: no visa_batch_applicants row found for id ${applicantId}`);
  }

  if (applicant.status !== 'active') {
    // Already cancelled/removed -- a non-active applicant can never have
    // an in-flight submission worth checking (see this feature's own
    // design audit on "provably never queued" for why this is safe).
    return { retired: false, conflictDetected: false };
  }

  const { rows: queueRows } = await client.query<{ id: string; status: VisaSubmissionStatus }>(
    `SELECT id, status FROM visa_submission_queue WHERE visa_batch_applicant_id = $1 FOR UPDATE`,
    [applicantId],
  );
  const queueRow = queueRows[0];

  let conflictDetected = false;
  if (queueRow && queueRow.status === 'SUBMITTING') {
    conflictDetected = true;
    await client.query(`UPDATE visa_submission_queue SET conflict_detected_at = now() WHERE id = $1 AND conflict_detected_at IS NULL`, [
      queueRow.id,
    ]);
    // Alert the operator IMMEDIATELY, inside this same transaction --
    // never wait for recoverStaleSubmittingToAmbiguous's own stale-timeout
    // sweep to eventually notice. The submission itself (visa_submission_queue.status)
    // is NEVER touched here: it stays SUBMITTING, never auto-reset to
    // PENDING -- see this function's own doc comment on why an ambiguous
    // portal outcome must never trigger an automatic resubmission.
    await recordConflictAlertWithClient(client, queueRow.id, applicant.batch_id, alertDetail);
  }

  await client.query(`UPDATE visa_batch_applicants SET status = $2 WHERE id = $1`, [applicantId, newStatus]);

  return { retired: true, conflictDetected };
}

export interface CancelWithConflictCheckResult {
  /** false when the applicant was already cancelled/removed -- a safe no-op, not an error. */
  cancelled: boolean;
  /** true when a SUBMITTING queue row was found for this applicant -- see this function's own doc comment. */
  conflictDetected: boolean;
}

/**
 * Cancels (or removes) one visa_batch_applicants row, checking for a
 * submission-in-flight conflict INSIDE the same transaction, before
 * COMMIT -- the confirmed, mandatory design decision for this feature
 * (conflict-check must be atomic with the cancellation, never a separate,
 * later step). On any error, the WHOLE transaction rolls back: the
 * applicant's status change is never left partially applied.
 *
 * A thin transactional wrapper around retireApplicantWithConflictCheckWithClient
 * above (Package 5.6) -- this function's own external signature and
 * behavior are unchanged; only the per-applicant lock/conflict-check logic
 * itself is now shared with the other retirement call sites (group/identity
 * state changes, identity merge).
 */
export async function cancelWithConflictCheck(
  visaBatchApplicantId: string,
  newStatus: Extract<VisaBatchApplicantStatus, 'cancelled' | 'removed'>,
): Promise<CancelWithConflictCheckResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const result = await retireApplicantWithConflictCheckWithClient(
      client,
      visaBatchApplicantId,
      newStatus,
      `conflict detected while cancelling visa_batch_applicant ${visaBatchApplicantId}`,
    );

    await client.query('COMMIT');
    return { cancelled: result.retired, conflictDetected: result.conflictDetected };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * The owning group_id for one visa_batch_applicants row, or null if it
 * does not exist. Used by operator commands (visaStopApplicantCommand.ts,
 * visaCheckAmbiguousCommand.ts) to confirm an applicant actually belongs
 * to the group the requesting operator is acting from, BEFORE touching
 * anything -- the same (never-leaking) "not found" outcome is returned
 * whether the id is simply wrong or belongs to a different group. A tiny,
 * standalone read added here (rather than to visaBatches.repo.ts) to keep
 * this feature's own files self-contained -- same choice already made for
 * visaSubmissionQueuePostgresStore.ts's own findApplicantPassportIdentityId.
 */
export async function findApplicantGroupId(visaBatchApplicantId: string): Promise<string | null> {
  const { rows } = await pool.query<{ group_id: string }>(`SELECT group_id FROM visa_batch_applicants WHERE id = $1`, [
    visaBatchApplicantId,
  ]);
  return rows[0]?.group_id ?? null;
}

export type FlagAmbiguousForReviewOutcome = 'not-ambiguous' | 'flagged' | 'already-flagged';

/**
 * The "PORTALDA TEKSHIRISH" primitive: for a queue row currently
 * AMBIGUOUS, durably records that an operator must check the real portal
 * directly, via the SAME two tables migrations/0028 already provisioned
 * for exactly this (visa_submission_reviews, visa_operator_alerts's
 * 'ambiguous_submission' type) -- no schema change needed.
 *
 * Never touches visa_submission_queue.status itself -- this is a pure
 * annotation of an EXISTING AMBIGUOUS row, never a transition away from
 * it, so it can never be mistaken for (or misused as) an automatic
 * resubmission path. Returns 'not-ambiguous' without writing anything if
 * the row isn't currently AMBIGUOUS (checked with FOR UPDATE, inside the
 * same transaction as the writes, so a concurrent finalize can't race
 * this into flagging a row that just left AMBIGUOUS).
 *
 * Idempotency: the operator-alert write is DB-constraint-backed
 * (UNIQUE(alert_type, event_id), event_id = this queue row's own id --
 * same idiom as recordConflictAlertWithClient). The review row itself has
 * no DB-level uniqueness (visa_submission_reviews, migration 0028, carries
 * only its PRIMARY KEY) -- this function instead checks for an existing
 * PENDING review for this queue row first, inside the same transaction,
 * before inserting. This is application-level, check-then-insert
 * idempotency, not a DB constraint: safe for human-paced operator
 * button-presses (the realistic caller here), but NOT a hard guarantee
 * under truly concurrent, high-frequency callers -- see this function's
 * own README note if that ever changes. Adding a DB-level guard (e.g. a
 * partial UNIQUE index on visa_submission_reviews) would need a new
 * migration; none is added here, per this round's own instruction not to
 * invent schema changes casually.
 */
export async function flagAmbiguousForReview(queueId: string, detail: string | null): Promise<FlagAmbiguousForReviewOutcome> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query<{ status: VisaSubmissionStatus; batch_id: string }>(
      `SELECT status, batch_id FROM visa_submission_queue WHERE id = $1 FOR UPDATE`,
      [queueId],
    );
    const row = rows[0];
    if (!row || row.status !== 'AMBIGUOUS') {
      await client.query('COMMIT');
      return 'not-ambiguous';
    }

    const { rows: existingReview } = await client.query<{ id: string }>(
      `SELECT id FROM visa_submission_reviews WHERE visa_submission_queue_id = $1 AND status = 'pending' LIMIT 1`,
      [queueId],
    );
    const alreadyFlagged = existingReview.length > 0;
    if (!alreadyFlagged) {
      await client.query(`INSERT INTO visa_submission_reviews (visa_submission_queue_id, detail) VALUES ($1, $2)`, [queueId, detail]);
    }

    await client.query(
      `INSERT INTO visa_operator_alerts (event_id, alert_type, batch_id, visa_submission_queue_id, detail)
       VALUES ($1, 'ambiguous_submission', $2, $1, $3)
       ON CONFLICT (alert_type, event_id) DO NOTHING`,
      [queueId, row.batch_id, detail],
    );

    await client.query('COMMIT');
    return alreadyFlagged ? 'already-flagged' : 'flagged';
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export interface AttentionNeededRecord {
  queueId: string;
  visaBatchApplicantId: string;
  status: VisaSubmissionStatus;
  positionInBatch: number;
}

/**
 * Queue rows in this batch that genuinely need an operator's attention --
 * a detected cancellation conflict while still SUBMITTING, or a fully
 * AMBIGUOUS outcome. Deliberately excludes plain PENDING/SAVED/ERROR rows:
 * those are either routine (nothing to review) or already final in a way
 * this attention view isn't meant to surface. A plain PENDING item can
 * still be stopped directly via the existing reply-based
 * /visa_stop_applicant command -- this view is scoped to what actually
 * needs a decision. Read-only; joins visa_batch_applicants only for its
 * own position_in_batch (an existing, already-exposed field, never a new
 * one).
 */
export async function findAttentionNeededForBatch(batchId: string): Promise<AttentionNeededRecord[]> {
  const { rows } = await pool.query<{
    id: string;
    visa_batch_applicant_id: string;
    status: VisaSubmissionStatus;
    position_in_batch: number;
  }>(
    `SELECT q.id, q.visa_batch_applicant_id, q.status, a.position_in_batch
     FROM visa_submission_queue q
     JOIN visa_batch_applicants a ON a.id = q.visa_batch_applicant_id
     WHERE q.batch_id = $1
       AND ((q.status = 'SUBMITTING' AND q.conflict_detected_at IS NOT NULL) OR q.status = 'AMBIGUOUS')
     ORDER BY a.position_in_batch`,
    [batchId],
  );
  return rows.map((row) => ({
    queueId: row.id,
    visaBatchApplicantId: row.visa_batch_applicant_id,
    status: row.status,
    positionInBatch: row.position_in_batch,
  }));
}

export interface PendingQueueApplicant {
  recordId: string;
  groupId: string;
  passportIdentityId: string;
  positionInBatch: number;
}

/**
 * Package 5.43 -- PENDING queue rows for this batch, each paired with its
 * own applicant's passport_identity_id and canonical position_in_batch --
 * exactly the shape visaWorkerLoop.ts's own VisaWorkerLoopApplicantInput
 * needs to drive runVisaWorkerLoopForBatch, in the SAME canonical order
 * findActiveApplicantPositionsForBatch's own ORDER BY already uses (so
 * isLastApplicantInBatch stays correct downstream). No existing function
 * in this file already produced this exact join -- the closest, findAttentionNeededForBatch,
 * is deliberately scoped to SUBMITTING-with-conflict/AMBIGUOUS rows only,
 * never PENDING. Read-only; joins visa_batch_applicants only for its own,
 * already-exposed passport_identity_id/position_in_batch fields -- the
 * SAME established join pattern findAttentionNeededForBatch's own query
 * already uses, not a new one invented here.
 */
export async function findPendingQueueApplicantsForBatch(batchId: string): Promise<PendingQueueApplicant[]> {
  const { rows } = await pool.query<{
    id: string;
    group_id: string;
    passport_identity_id: string;
    position_in_batch: number;
  }>(
    `SELECT q.id, q.group_id, a.passport_identity_id, a.position_in_batch
     FROM visa_submission_queue q
     JOIN visa_batch_applicants a ON a.id = q.visa_batch_applicant_id
     WHERE q.batch_id = $1 AND q.status = 'PENDING'
     ORDER BY a.position_in_batch ASC`,
    [batchId],
  );
  return rows.map((row) => ({
    recordId: row.id,
    groupId: row.group_id,
    passportIdentityId: row.passport_identity_id,
    positionInBatch: row.position_in_batch,
  }));
}
