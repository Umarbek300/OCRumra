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
