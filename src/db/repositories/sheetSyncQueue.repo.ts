import { pool } from '../pool.js';

export type SheetSyncStatus = 'pending' | 'syncing' | 'synced' | 'failed';

export interface SheetSyncQueueRecord {
  id: string;
  telegramMessageId: string;
  status: SheetSyncStatus;
  attempts: number;
  lastError: string | null;
  sheetRowNumber: number | null;
  nextAttemptAt: string;
  syncedAt: string | null;
  /** When the post-sync Telegram confirmation message was sent, or null if not sent yet. See markSheetSyncConfirmationSent. */
  confirmationSentAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface SheetSyncQueueRow {
  id: string;
  telegram_message_id: string;
  status: SheetSyncStatus;
  attempts: number;
  last_error: string | null;
  sheet_row_number: number | null;
  next_attempt_at: string;
  synced_at: string | null;
  confirmation_sent_at: string | null;
  created_at: string;
  updated_at: string;
}

function mapRow(row: SheetSyncQueueRow): SheetSyncQueueRecord {
  return {
    id: row.id,
    telegramMessageId: row.telegram_message_id,
    status: row.status,
    attempts: row.attempts,
    lastError: row.last_error,
    sheetRowNumber: row.sheet_row_number,
    nextAttemptAt: row.next_attempt_at,
    syncedAt: row.synced_at,
    confirmationSentAt: row.confirmation_sent_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT_COLUMNS = `
  id, telegram_message_id, status, attempts, last_error,
  sheet_row_number, next_attempt_at, synced_at, confirmation_sent_at, created_at, updated_at
`;

/**
 * Creates the one-and-only sheet-sync job for a telegram_message. Returns
 * null if one already exists (telegram_message_id is UNIQUE, same
 * idempotency guarantee as passport_processing) — safe to call repeatedly
 * for the same message, including from multiple call sites, without ever
 * producing a duplicate queue row.
 */
export async function enqueueSheetSync(telegramMessageId: string): Promise<SheetSyncQueueRecord | null> {
  const { rows } = await pool.query<SheetSyncQueueRow>(
    `INSERT INTO sheet_sync_queue (telegram_message_id)
     VALUES ($1)
     ON CONFLICT (telegram_message_id) DO NOTHING
     RETURNING ${SELECT_COLUMNS}`,
    [telegramMessageId],
  );
  const row = rows[0];
  return row ? mapRow(row) : null;
}

export async function findSheetSyncQueueById(id: string): Promise<SheetSyncQueueRecord | null> {
  const { rows } = await pool.query<SheetSyncQueueRow>(`SELECT ${SELECT_COLUMNS} FROM sheet_sync_queue WHERE id = $1`, [id]);
  const row = rows[0];
  return row ? mapRow(row) : null;
}

export async function findSheetSyncQueueByTelegramMessageId(
  telegramMessageId: string,
): Promise<SheetSyncQueueRecord | null> {
  const { rows } = await pool.query<SheetSyncQueueRow>(
    `SELECT ${SELECT_COLUMNS} FROM sheet_sync_queue WHERE telegram_message_id = $1`,
    [telegramMessageId],
  );
  const row = rows[0];
  return row ? mapRow(row) : null;
}

/** Default cap on how many due jobs one poll cycle pulls at once — a future sync worker's own concern, not a business rule. */
export const DEFAULT_DUE_JOBS_LIMIT = 20;

/**
 * Single shared cap on how many times any one job may ever be attempted —
 * "attempted" meaning claimed via markSheetSyncStarted, regardless of why
 * that attempt ultimately didn't finish (a normal Sheets/API failure via
 * markSheetSyncFailed, or an abandoned/crashed worker recovered via
 * recoverStaleSyncingJobs below). One number, used consistently by both
 * findDueSheetSyncJobs (stops offering the job for normal retry once
 * reached) and recoverStaleSyncingJobs (stops requeuing a stale row once
 * reached) — so a job's total attempt budget is the same regardless of
 * which path it failed through.
 */
export const MAX_SHEET_SYNC_ATTEMPTS = 5;

/**
 * Jobs ready to (re)attempt: 'pending' (never tried) or 'failed' (retry
 * eligible again) whose next_attempt_at has arrived AND whose attempts
 * count hasn't yet reached maxAttempts, oldest first. Never selects
 * 'syncing' (already claimed) or 'synced' (done) rows.
 *
 * A 'failed' row that reached maxAttempts is deliberately excluded here —
 * it is a permanent failure, not silently dropped: it stays visible at
 * status='failed' with its real attempts/last_error for an operator to
 * query directly (`SELECT * FROM sheet_sync_queue WHERE status='failed'
 * AND attempts >= 5`), it is simply never offered to this function again.
 * next_attempt_at is left as whatever markSheetSyncFailed's caller last
 * set (never NULL — the column is NOT NULL) — it just stops mattering once
 * this WHERE clause excludes the row on attempts alone.
 */
export async function findDueSheetSyncJobs(
  limit: number = DEFAULT_DUE_JOBS_LIMIT,
  maxAttempts: number = MAX_SHEET_SYNC_ATTEMPTS,
): Promise<SheetSyncQueueRecord[]> {
  const { rows } = await pool.query<SheetSyncQueueRow>(
    `SELECT ${SELECT_COLUMNS} FROM sheet_sync_queue
     WHERE status IN ('pending', 'failed') AND next_attempt_at <= now() AND attempts < $2
     ORDER BY next_attempt_at
     LIMIT $1`,
    [limit, maxAttempts],
  );
  return rows.map(mapRow);
}

/**
 * Atomically claims a due job: pending/failed -> syncing, attempts += 1.
 * Returns null if the row wasn't in a claimable state (already claimed by
 * another worker, already synced, or not yet due) — the guard against
 * double-processing, same shape as markPassportProcessingStarted.
 */
export async function markSheetSyncStarted(id: string): Promise<SheetSyncQueueRecord | null> {
  const { rows } = await pool.query<SheetSyncQueueRow>(
    `UPDATE sheet_sync_queue
     SET status = 'syncing', attempts = attempts + 1
     WHERE id = $1 AND status IN ('pending', 'failed')
     RETURNING ${SELECT_COLUMNS}`,
    [id],
  );
  const row = rows[0];
  return row ? mapRow(row) : null;
}

/**
 * Marks a job successfully written to the sheet. sheetRowNumber is
 * recorded when known (so a future re-sync of this same row, e.g. an
 * edited OCR result, can UPDATE in place instead of re-scanning the whole
 * sheet) — pass null if the caller has no row number to report.
 */
export async function markSheetSyncSynced(
  id: string,
  sheetRowNumber: number | null,
): Promise<SheetSyncQueueRecord | null> {
  const { rows } = await pool.query<SheetSyncQueueRow>(
    `UPDATE sheet_sync_queue
     SET status = 'synced', synced_at = now(), sheet_row_number = $2, last_error = NULL
     WHERE id = $1
     RETURNING ${SELECT_COLUMNS}`,
    [id, sheetRowNumber],
  );
  const row = rows[0];
  return row ? mapRow(row) : null;
}

/**
 * Marks a job failed and schedules its next retry via next_attempt_at.
 * Defaults to "eligible immediately" (now()) when the caller has no
 * specific backoff to apply yet — the actual backoff curve (e.g.
 * exponential) is the future sync worker's policy, not this repository's.
 */
export async function markSheetSyncFailed(
  id: string,
  errorMessage: string,
  nextAttemptAt: Date = new Date(),
): Promise<SheetSyncQueueRecord | null> {
  const { rows } = await pool.query<SheetSyncQueueRow>(
    `UPDATE sheet_sync_queue
     SET status = 'failed', last_error = $2, next_attempt_at = $3
     WHERE id = $1
     RETURNING ${SELECT_COLUMNS}`,
    [id, errorMessage, nextAttemptAt],
  );
  const row = rows[0];
  return row ? mapRow(row) : null;
}

/** A row stuck in 'syncing' past this many minutes is considered abandoned (sync worker crash/restart mid-job). */
export const STALE_SYNCING_TIMEOUT_MINUTES = 10;

export interface StaleSheetSyncRecoveryResult {
  requeued: SheetSyncQueueRecord[];
  failed: SheetSyncQueueRecord[];
}

/**
 * Reconciles 'syncing' rows abandoned by a crashed/killed sync worker —
 * the same problem passport_processing's recoverStaleProcessingJobs solves
 * for OCR jobs. There is no separate started_at column here, so staleness
 * is judged from updated_at (the set_updated_at trigger touches it on the
 * very UPDATE that set status = 'syncing' in markSheetSyncStarted).
 *
 * A stale row is either requeued (status -> 'pending', immediately
 * eligible via next_attempt_at = now()) when it still has attempts left,
 * or given up (status -> 'failed') once attempts already reached
 * maxAttempts. Both are single atomic UPDATE ... RETURNING statements
 * scoped by status = 'syncing', so calling this repeatedly/concurrently is
 * safe: a row this call already moved to 'pending' or 'failed' no longer
 * matches either WHERE clause on a later call.
 */
export async function recoverStaleSyncingJobs(
  timeoutMinutes: number = STALE_SYNCING_TIMEOUT_MINUTES,
  maxAttempts: number = MAX_SHEET_SYNC_ATTEMPTS,
): Promise<StaleSheetSyncRecoveryResult> {
  const { rows: requeuedRows } = await pool.query<SheetSyncQueueRow>(
    `UPDATE sheet_sync_queue
     SET status = 'pending', next_attempt_at = now()
     WHERE status = 'syncing'
       AND updated_at < now() - ($1 * interval '1 minute')
       AND attempts < $2
     RETURNING ${SELECT_COLUMNS}`,
    [timeoutMinutes, maxAttempts],
  );

  const { rows: failedRows } = await pool.query<SheetSyncQueueRow>(
    `UPDATE sheet_sync_queue
     SET status = 'failed',
         last_error = 'gave up after exceeding max sheet-sync attempts following a stale/crashed sync worker'
     WHERE status = 'syncing'
       AND updated_at < now() - ($1 * interval '1 minute')
       AND attempts >= $2
     RETURNING ${SELECT_COLUMNS}`,
    [timeoutMinutes, maxAttempts],
  );

  return { requeued: requeuedRows.map(mapRow), failed: failedRows.map(mapRow) };
}

/**
 * Atomically claims the right to send this job's post-sync Telegram
 * confirmation: sets confirmation_sent_at = now() only if it is still NULL,
 * same "claim guard" shape as markSheetSyncStarted. Returns null if a
 * confirmation was already sent (or being sent) for this job, so the caller
 * knows to skip sending — the sole guard against a duplicate confirmation
 * message, including for a job an operator manually resets and re-syncs.
 *
 * The caller is expected to send the message only after winning this claim.
 * If the send then fails, call clearSheetSyncConfirmationSent to allow a
 * future attempt to try again — see syncPassportRowToSheet.ts.
 */
export async function markSheetSyncConfirmationSent(id: string): Promise<SheetSyncQueueRecord | null> {
  const { rows } = await pool.query<SheetSyncQueueRow>(
    `UPDATE sheet_sync_queue
     SET confirmation_sent_at = now()
     WHERE id = $1 AND confirmation_sent_at IS NULL
     RETURNING ${SELECT_COLUMNS}`,
    [id],
  );
  const row = rows[0];
  return row ? mapRow(row) : null;
}

/**
 * Rolls back a confirmation claim after the actual Telegram send failed, so
 * confirmation_sent_at keeps meaning "successfully sent" rather than
 * "attempted". Unconditional by id (no WHERE ... IS NULL guard) — only ever
 * called by the same code path that just won the claim via
 * markSheetSyncConfirmationSent, so there is no concurrent claim to disturb.
 */
export async function clearSheetSyncConfirmationSent(id: string): Promise<void> {
  await pool.query(`UPDATE sheet_sync_queue SET confirmation_sent_at = NULL WHERE id = $1`, [id]);
}

/**
 * Resets an existing 'synced' job back to 'pending' so the next poll
 * cycle re-processes it — used when a message's canonical resolution
 * changes AFTER it was already synced (identity split is the first
 * caller), and the Sheet needs to be brought back in sync through the
 * normal sheet_sync_queue pipeline rather than a bespoke direct write.
 * A no-op (returns null) if the job isn't currently 'synced' — e.g. it's
 * already pending/syncing (nothing to do, the next ordinary poll will
 * already re-resolve canonical fresh) or doesn't exist at all (never
 * silently creates one; a genuinely missing job means this message was
 * never synced in the first place).
 */
export async function requeueSheetSyncForResync(telegramMessageId: string): Promise<SheetSyncQueueRecord | null> {
  const { rows } = await pool.query<SheetSyncQueueRow>(
    `UPDATE sheet_sync_queue
     SET status = 'pending', next_attempt_at = now()
     WHERE telegram_message_id = $1 AND status = 'synced'
     RETURNING ${SELECT_COLUMNS}`,
    [telegramMessageId],
  );
  const row = rows[0];
  return row ? mapRow(row) : null;
}
