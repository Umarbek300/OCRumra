import { pool } from '../pool.js';

export type PassportProcessingStatus = 'queued' | 'processing' | 'completed' | 'failed';

export interface PassportProcessingRecord {
  id: string;
  telegramMessageId: string;
  status: PassportProcessingStatus;
  attempts: number;
  lastError: string | null;
  queuedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface PassportProcessingRow {
  id: string;
  telegram_message_id: string;
  status: PassportProcessingStatus;
  attempts: number;
  last_error: string | null;
  queued_at: string;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

function mapRow(row: PassportProcessingRow): PassportProcessingRecord {
  return {
    id: row.id,
    telegramMessageId: row.telegram_message_id,
    status: row.status,
    attempts: row.attempts,
    lastError: row.last_error,
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT_COLUMNS = `
  id, telegram_message_id, status, attempts, last_error,
  queued_at, started_at, completed_at, created_at, updated_at
`;

/**
 * Creates the one-and-only processing record for a telegram_message.
 * Returns null if one already exists (telegram_message_id is UNIQUE) —
 * callers use that to skip re-enqueuing.
 */
export async function createPassportProcessingRecord(
  telegramMessageId: string,
): Promise<PassportProcessingRecord | null> {
  const { rows } = await pool.query<PassportProcessingRow>(
    `INSERT INTO passport_processing (telegram_message_id)
     VALUES ($1)
     ON CONFLICT (telegram_message_id) DO NOTHING
     RETURNING ${SELECT_COLUMNS}`,
    [telegramMessageId],
  );
  const row = rows[0];
  return row ? mapRow(row) : null;
}

export async function findPassportProcessingById(id: string): Promise<PassportProcessingRecord | null> {
  const { rows } = await pool.query<PassportProcessingRow>(
    `SELECT ${SELECT_COLUMNS} FROM passport_processing WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  return row ? mapRow(row) : null;
}

export async function findPassportProcessingByTelegramMessageId(
  telegramMessageId: string,
): Promise<PassportProcessingRecord | null> {
  const { rows } = await pool.query<PassportProcessingRow>(
    `SELECT ${SELECT_COLUMNS} FROM passport_processing WHERE telegram_message_id = $1`,
    [telegramMessageId],
  );
  const row = rows[0];
  return row ? mapRow(row) : null;
}

/**
 * Atomically claims a queued job: queued -> processing, attempts += 1.
 * Returns null if the row wasn't in 'queued' state (already claimed by
 * another worker, or not eligible) — the guard against double-processing.
 */
export async function markPassportProcessingStarted(id: string): Promise<PassportProcessingRecord | null> {
  const { rows } = await pool.query<PassportProcessingRow>(
    `UPDATE passport_processing
     SET status = 'processing', attempts = attempts + 1, started_at = now()
     WHERE id = $1 AND status = 'queued'
     RETURNING ${SELECT_COLUMNS}`,
    [id],
  );
  const row = rows[0];
  return row ? mapRow(row) : null;
}

export async function markPassportProcessingCompleted(id: string): Promise<PassportProcessingRecord | null> {
  const { rows } = await pool.query<PassportProcessingRow>(
    `UPDATE passport_processing
     SET status = 'completed', completed_at = now(), last_error = NULL
     WHERE id = $1
     RETURNING ${SELECT_COLUMNS}`,
    [id],
  );
  const row = rows[0];
  return row ? mapRow(row) : null;
}

export async function markPassportProcessingFailed(
  id: string,
  errorMessage: string,
): Promise<PassportProcessingRecord | null> {
  const { rows } = await pool.query<PassportProcessingRow>(
    `UPDATE passport_processing
     SET status = 'failed', last_error = $2
     WHERE id = $1
     RETURNING ${SELECT_COLUMNS}`,
    [id, errorMessage],
  );
  const row = rows[0];
  return row ? mapRow(row) : null;
}

/** A row stuck in 'processing' past this many minutes is considered abandoned (worker crash/restart mid-job). */
export const STALE_PROCESSING_TIMEOUT_MINUTES = 10;
/** Past this many attempts, a stale row is given up to 'failed' instead of requeued, to avoid an infinite retry loop. */
export const MAX_PROCESSING_ATTEMPTS = 3;

export interface StaleProcessingRecoveryResult {
  requeued: PassportProcessingRecord[];
  failed: PassportProcessingRecord[];
}

/**
 * Reconciles 'processing' rows abandoned by a crashed/killed worker.
 * Redis's BRPOP already removed the job from the queue irrevocably the
 * moment it was dequeued (see passportProcessingQueue.ts), so without this
 * a crash between dequeue and completion leaves the row stuck in
 * 'processing' forever, with no way back onto the queue.
 *
 * A stale row (started_at older than timeoutMinutes) is either requeued
 * (status -> 'queued', attempts left as-is; the next claim via
 * markPassportProcessingStarted bumps it as usual) when it still has
 * attempts left, or given up (status -> 'failed') once attempts has
 * already reached maxAttempts, so a job that keeps crashing the worker
 * can't loop forever.
 *
 * Both updates are single atomic UPDATE ... RETURNING statements scoped by
 * status = 'processing', so calling this repeatedly/concurrently is safe:
 * a row this call already moved to 'queued' or 'failed' no longer matches
 * either WHERE clause on a later call.
 */
export async function recoverStaleProcessingJobs(
  timeoutMinutes: number = STALE_PROCESSING_TIMEOUT_MINUTES,
  maxAttempts: number = MAX_PROCESSING_ATTEMPTS,
): Promise<StaleProcessingRecoveryResult> {
  const { rows: requeuedRows } = await pool.query<PassportProcessingRow>(
    `UPDATE passport_processing
     SET status = 'queued'
     WHERE status = 'processing'
       AND started_at < now() - ($1 * interval '1 minute')
       AND attempts < $2
     RETURNING ${SELECT_COLUMNS}`,
    [timeoutMinutes, maxAttempts],
  );

  const { rows: failedRows } = await pool.query<PassportProcessingRow>(
    `UPDATE passport_processing
     SET status = 'failed',
         last_error = 'gave up after exceeding max processing attempts following a stale/crashed worker'
     WHERE status = 'processing'
       AND started_at < now() - ($1 * interval '1 minute')
       AND attempts >= $2
     RETURNING ${SELECT_COLUMNS}`,
    [timeoutMinutes, maxAttempts],
  );

  return { requeued: requeuedRows.map(mapRow), failed: failedRows.map(mapRow) };
}

/** A row stuck in 'queued' past this many minutes likely lost its Redis queue entry. */
export const QUEUED_STALE_TIMEOUT_MINUTES = 10;

/**
 * Finds 'queued' rows old enough that they likely lost their Redis queue
 * entry -- e.g. a worker crash between BRPOP (which pops irrevocably, see
 * passportProcessingQueue.ts) and markPassportProcessingStarted's claim, or
 * a transient Redis failure during the original enqueue in
 * ingestPhotoMessage.ts. Read-only: status/attempts/queued_at are left
 * untouched here. The caller (recoverAndRequeueStaleProcessingJobs) is
 * expected to re-push each returned row onto Redis; this is always safe
 * even if the row actually still has a live queue entry, because
 * markPassportProcessingStarted's atomic `WHERE status = 'queued'` claim
 * means a duplicate Redis entry for the same row just gets skipped as
 * "already claimed" the second time it's dequeued, never double-processed.
 */
export async function findStaleQueuedJobs(
  timeoutMinutes: number = QUEUED_STALE_TIMEOUT_MINUTES,
): Promise<PassportProcessingRecord[]> {
  const { rows } = await pool.query<PassportProcessingRow>(
    `SELECT ${SELECT_COLUMNS} FROM passport_processing
     WHERE status = 'queued'
       AND queued_at < now() - ($1 * interval '1 minute')`,
    [timeoutMinutes],
  );
  return rows.map(mapRow);
}
