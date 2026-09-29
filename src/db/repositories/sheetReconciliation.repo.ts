import type { PoolClient } from 'pg';
import { pool } from '../pool.js';

export type SheetReconciliationStatus = 'pending' | 'processing' | 'done' | 'failed';

export interface SheetReconciliationJobRecord {
  id: string;
  passportIdentityId: string;
  groupId: string;
  expectedOldCanonicalTelegramMessageId: string;
  sourceOperation: string;
  sourceEventId: string | null;
  status: SheetReconciliationStatus;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

interface SheetReconciliationJobRow {
  id: string;
  passport_identity_id: string;
  group_id: string;
  expected_old_canonical_telegram_message_id: string;
  source_operation: string;
  source_event_id: string | null;
  status: SheetReconciliationStatus;
  attempts: number;
  last_error: string | null;
  next_attempt_at: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

function mapRow(row: SheetReconciliationJobRow): SheetReconciliationJobRecord {
  return {
    id: row.id,
    passportIdentityId: row.passport_identity_id,
    groupId: row.group_id,
    expectedOldCanonicalTelegramMessageId: row.expected_old_canonical_telegram_message_id,
    sourceOperation: row.source_operation,
    sourceEventId: row.source_event_id,
    status: row.status,
    attempts: row.attempts,
    lastError: row.last_error,
    nextAttemptAt: row.next_attempt_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

const SELECT_COLUMNS = `
  id, passport_identity_id, group_id, expected_old_canonical_telegram_message_id,
  source_operation, source_event_id, status, attempts, last_error,
  next_attempt_at, created_at, updated_at, completed_at
`;

export interface InsertReconciliationJobInput {
  passportIdentityId: string;
  groupId: string;
  expectedOldCanonicalTelegramMessageId: string;
  sourceOperation: string;
  sourceEventId: string | null;
}

/**
 * Inserts a reconciliation job using the CALLER'S OWN transaction client —
 * this is the crash-safety mechanism itself. Every caller MUST invoke this
 * inside the exact same BEGIN/COMMIT as the domain state change it
 * accompanies (see applyIdentityStateChange.ts's transactional cores),
 * never against the shared pool on its own: a crash between the domain
 * UPDATE and this INSERT would otherwise reintroduce precisely the gap
 * this table exists to close.
 */
export async function insertReconciliationJobWithClient(
  client: PoolClient,
  input: InsertReconciliationJobInput,
): Promise<void> {
  await client.query(
    `INSERT INTO sheet_reconciliation_jobs
       (passport_identity_id, group_id, expected_old_canonical_telegram_message_id, source_operation, source_event_id)
     VALUES ($1,$2,$3,$4,$5)`,
    [input.passportIdentityId, input.groupId, input.expectedOldCanonicalTelegramMessageId, input.sourceOperation, input.sourceEventId],
  );
}

export const DEFAULT_DUE_RECONCILIATION_JOBS_LIMIT = 20;

/** Same shared-attempt-budget idea as sheet_sync_queue's MAX_SHEET_SYNC_ATTEMPTS, applied to this table. */
export const MAX_RECONCILIATION_ATTEMPTS = 5;

/** Jobs ready to (re)attempt: 'pending' or 'failed', due, under the attempt cap — same shape as findDueSheetSyncJobs. */
export async function findDueReconciliationJobs(
  limit: number = DEFAULT_DUE_RECONCILIATION_JOBS_LIMIT,
  maxAttempts: number = MAX_RECONCILIATION_ATTEMPTS,
): Promise<SheetReconciliationJobRecord[]> {
  const { rows } = await pool.query<SheetReconciliationJobRow>(
    `SELECT ${SELECT_COLUMNS} FROM sheet_reconciliation_jobs
     WHERE status IN ('pending', 'failed') AND next_attempt_at <= now() AND attempts < $2
     ORDER BY next_attempt_at
     LIMIT $1`,
    [limit, maxAttempts],
  );
  return rows.map(mapRow);
}

/** Atomically claims a due job: pending/failed -> processing, attempts += 1. Null if not claimable (already claimed, done, or not yet due). */
export async function claimReconciliationJob(id: string): Promise<SheetReconciliationJobRecord | null> {
  const { rows } = await pool.query<SheetReconciliationJobRow>(
    `UPDATE sheet_reconciliation_jobs
     SET status = 'processing', attempts = attempts + 1
     WHERE id = $1 AND status IN ('pending', 'failed')
     RETURNING ${SELECT_COLUMNS}`,
    [id],
  );
  const row = rows[0];
  return row ? mapRow(row) : null;
}

export async function markReconciliationJobDone(id: string): Promise<SheetReconciliationJobRecord | null> {
  const { rows } = await pool.query<SheetReconciliationJobRow>(
    `UPDATE sheet_reconciliation_jobs
     SET status = 'done', completed_at = now(), last_error = NULL
     WHERE id = $1
     RETURNING ${SELECT_COLUMNS}`,
    [id],
  );
  const row = rows[0];
  return row ? mapRow(row) : null;
}

export async function markReconciliationJobFailed(
  id: string,
  errorMessage: string,
  nextAttemptAt: Date = new Date(),
): Promise<SheetReconciliationJobRecord | null> {
  const { rows } = await pool.query<SheetReconciliationJobRow>(
    `UPDATE sheet_reconciliation_jobs
     SET status = 'failed', last_error = $2, next_attempt_at = $3
     WHERE id = $1
     RETURNING ${SELECT_COLUMNS}`,
    [id, errorMessage, nextAttemptAt],
  );
  const row = rows[0];
  return row ? mapRow(row) : null;
}

export const STALE_RECONCILIATION_TIMEOUT_MINUTES = 10;

export interface StaleReconciliationRecoveryResult {
  requeued: SheetReconciliationJobRecord[];
  failed: SheetReconciliationJobRecord[];
}

/** Reconciles 'processing' rows abandoned by a crashed/killed reconciliation worker — same pattern as recoverStaleSyncingJobs/recoverStaleOperatorCommands. */
export async function recoverStaleReconciliationJobs(
  timeoutMinutes: number = STALE_RECONCILIATION_TIMEOUT_MINUTES,
  maxAttempts: number = MAX_RECONCILIATION_ATTEMPTS,
): Promise<StaleReconciliationRecoveryResult> {
  const { rows: requeuedRows } = await pool.query<SheetReconciliationJobRow>(
    `UPDATE sheet_reconciliation_jobs
     SET status = 'pending', next_attempt_at = now()
     WHERE status = 'processing'
       AND updated_at < now() - ($1 * interval '1 minute')
       AND attempts < $2
     RETURNING ${SELECT_COLUMNS}`,
    [timeoutMinutes, maxAttempts],
  );

  const { rows: failedRows } = await pool.query<SheetReconciliationJobRow>(
    `UPDATE sheet_reconciliation_jobs
     SET status = 'failed',
         last_error = 'gave up after exceeding max attempts following a stale/crashed reconciliation worker'
     WHERE status = 'processing'
       AND updated_at < now() - ($1 * interval '1 minute')
       AND attempts >= $2
     RETURNING ${SELECT_COLUMNS}`,
    [timeoutMinutes, maxAttempts],
  );

  return { requeued: requeuedRows.map(mapRow), failed: failedRows.map(mapRow) };
}

export async function findReconciliationJobById(id: string): Promise<SheetReconciliationJobRecord | null> {
  const { rows } = await pool.query<SheetReconciliationJobRow>(`SELECT ${SELECT_COLUMNS} FROM sheet_reconciliation_jobs WHERE id = $1`, [
    id,
  ]);
  const row = rows[0];
  return row ? mapRow(row) : null;
}

/** All jobs for one (identity, group) pair, oldest first — used by tests to assert stacked-job convergence. */
export async function findReconciliationJobsForIdentityGroup(
  passportIdentityId: string,
  groupId: string,
): Promise<SheetReconciliationJobRecord[]> {
  const { rows } = await pool.query<SheetReconciliationJobRow>(
    `SELECT ${SELECT_COLUMNS} FROM sheet_reconciliation_jobs
     WHERE passport_identity_id = $1 AND group_id = $2
     ORDER BY created_at`,
    [passportIdentityId, groupId],
  );
  return rows.map(mapRow);
}
