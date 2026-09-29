import { pool } from '../pool.js';

export type PassportOperatorCommandType = 'cancel_passport' | 'move_to_group' | 'remove_from_group';
export type PassportOperatorCommandStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface PassportOperatorCommandRecord {
  id: string;
  commandType: PassportOperatorCommandType;
  passportIdentityId: string;
  groupId: string | null;
  fromGroupId: string | null;
  toGroupId: string | null;
  telegramMessageId: string | null;
  operatorId: string;
  status: PassportOperatorCommandStatus;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

interface PassportOperatorCommandRow {
  id: string;
  command_type: PassportOperatorCommandType;
  passport_identity_id: string;
  group_id: string | null;
  from_group_id: string | null;
  to_group_id: string | null;
  telegram_message_id: string | null;
  operator_id: string;
  status: PassportOperatorCommandStatus;
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

function mapRow(row: PassportOperatorCommandRow): PassportOperatorCommandRecord {
  return {
    id: row.id,
    commandType: row.command_type,
    passportIdentityId: row.passport_identity_id,
    groupId: row.group_id,
    fromGroupId: row.from_group_id,
    toGroupId: row.to_group_id,
    telegramMessageId: row.telegram_message_id,
    operatorId: row.operator_id,
    status: row.status,
    attempts: row.attempts,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

const SELECT_COLUMNS = `
  id, command_type, passport_identity_id, group_id, from_group_id, to_group_id,
  telegram_message_id, operator_id, status, attempts, last_error,
  created_at, updated_at, completed_at
`;

export interface CreateCancelOrRemoveCommandInput {
  commandType: Extract<PassportOperatorCommandType, 'cancel_passport' | 'remove_from_group'>;
  passportIdentityId: string;
  groupId: string;
  telegramMessageId: string | null;
  operatorId: string;
}

export interface CreateMoveToGroupCommandInput {
  passportIdentityId: string;
  fromGroupId: string;
  toGroupId: string;
  telegramMessageId: string | null;
  operatorId: string;
}

export async function createCancelOrRemoveCommand(
  input: CreateCancelOrRemoveCommandInput,
): Promise<PassportOperatorCommandRecord> {
  const { rows } = await pool.query<PassportOperatorCommandRow>(
    `INSERT INTO passport_operator_commands (command_type, passport_identity_id, group_id, telegram_message_id, operator_id)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING ${SELECT_COLUMNS}`,
    [input.commandType, input.passportIdentityId, input.groupId, input.telegramMessageId, input.operatorId],
  );
  const row = rows[0];
  if (!row) throw new Error('createCancelOrRemoveCommand: insert unexpectedly returned no row');
  return mapRow(row);
}

export async function createMoveToGroupCommand(
  input: CreateMoveToGroupCommandInput,
): Promise<PassportOperatorCommandRecord> {
  const { rows } = await pool.query<PassportOperatorCommandRow>(
    `INSERT INTO passport_operator_commands (command_type, passport_identity_id, from_group_id, to_group_id, telegram_message_id, operator_id)
     VALUES ('move_to_group',$1,$2,$3,$4,$5)
     RETURNING ${SELECT_COLUMNS}`,
    [input.passportIdentityId, input.fromGroupId, input.toGroupId, input.telegramMessageId, input.operatorId],
  );
  const row = rows[0];
  if (!row) throw new Error('createMoveToGroupCommand: insert unexpectedly returned no row');
  return mapRow(row);
}

/**
 * Atomically claims a pending command: pending -> processing, attempts +=
 * 1. Returns null if the row wasn't in 'pending' state (already
 * claimed/completed/failed) — same claim-guard shape as
 * markPassportProcessingStarted / markSheetSyncStarted.
 */
export async function claimPassportOperatorCommand(id: string): Promise<PassportOperatorCommandRecord | null> {
  const { rows } = await pool.query<PassportOperatorCommandRow>(
    `UPDATE passport_operator_commands
     SET status = 'processing', attempts = attempts + 1
     WHERE id = $1 AND status = 'pending'
     RETURNING ${SELECT_COLUMNS}`,
    [id],
  );
  const row = rows[0];
  return row ? mapRow(row) : null;
}

export async function markPassportOperatorCommandCompleted(id: string): Promise<PassportOperatorCommandRecord | null> {
  const { rows } = await pool.query<PassportOperatorCommandRow>(
    `UPDATE passport_operator_commands
     SET status = 'completed', completed_at = now(), last_error = NULL
     WHERE id = $1
     RETURNING ${SELECT_COLUMNS}`,
    [id],
  );
  const row = rows[0];
  return row ? mapRow(row) : null;
}

export async function markPassportOperatorCommandFailed(
  id: string,
  errorMessage: string,
): Promise<PassportOperatorCommandRecord | null> {
  const { rows } = await pool.query<PassportOperatorCommandRow>(
    `UPDATE passport_operator_commands
     SET status = 'failed', last_error = $2
     WHERE id = $1
     RETURNING ${SELECT_COLUMNS}`,
    [id, errorMessage],
  );
  const row = rows[0];
  return row ? mapRow(row) : null;
}

export async function findPassportOperatorCommandById(id: string): Promise<PassportOperatorCommandRecord | null> {
  const { rows } = await pool.query<PassportOperatorCommandRow>(
    `SELECT ${SELECT_COLUMNS} FROM passport_operator_commands WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  return row ? mapRow(row) : null;
}

/**
 * Finds an already-pending command with the same shape (same type,
 * identity, and group(s)) — the idempotency check the production entry
 * point (src/admin/operatorCommand.ts / submitOperatorCommand.ts) uses to
 * avoid inserting a duplicate row when the same action is submitted twice
 * before the first has been processed. Deliberately does NOT also match
 * 'processing'/'completed'/'failed' commands — those are past the point
 * where "reuse the existing row" makes sense; a repeat submission after
 * completion is a genuinely new action request, not a duplicate of an
 * already-finished one.
 */
export async function findPendingCommandMatching(
  commandType: PassportOperatorCommandType,
  passportIdentityId: string,
  groupId: string | null,
  fromGroupId: string | null,
  toGroupId: string | null,
): Promise<PassportOperatorCommandRecord | null> {
  const { rows } = await pool.query<PassportOperatorCommandRow>(
    `SELECT ${SELECT_COLUMNS} FROM passport_operator_commands
     WHERE status = 'pending'
       AND command_type = $1
       AND passport_identity_id = $2
       AND group_id IS NOT DISTINCT FROM $3
       AND from_group_id IS NOT DISTINCT FROM $4
       AND to_group_id IS NOT DISTINCT FROM $5
     ORDER BY created_at
     LIMIT 1`,
    [commandType, passportIdentityId, groupId, fromGroupId, toGroupId],
  );
  const row = rows[0];
  return row ? mapRow(row) : null;
}

/** Pending commands ready to process, oldest first — what runOperatorCommandLoop.ts polls. */
export async function findPendingCommands(limit: number): Promise<PassportOperatorCommandRecord[]> {
  const { rows } = await pool.query<PassportOperatorCommandRow>(
    `SELECT ${SELECT_COLUMNS} FROM passport_operator_commands
     WHERE status = 'pending'
     ORDER BY created_at
     LIMIT $1`,
    [limit],
  );
  return rows.map(mapRow);
}

/** A row stuck in 'processing' past this many minutes is considered abandoned (crash mid-command). Same shape/value as passport_processing's own stale-recovery. */
export const STALE_COMMAND_TIMEOUT_MINUTES = 10;
export const MAX_COMMAND_ATTEMPTS = 3;

export interface StaleCommandRecoveryResult {
  requeued: PassportOperatorCommandRecord[];
  failed: PassportOperatorCommandRecord[];
}

/**
 * Reconciles 'processing' commands abandoned by a crashed/killed process —
 * same pattern as recoverStaleProcessingJobs / recoverStaleSyncingJobs.
 * Renumbering (§H step 6) is always recomputed wholesale from a fresh
 * read, so simply requeuing a stale command for reprocessing is safe and
 * naturally idempotent, never double-applies a partial effect.
 */
export async function recoverStaleOperatorCommands(
  timeoutMinutes: number = STALE_COMMAND_TIMEOUT_MINUTES,
  maxAttempts: number = MAX_COMMAND_ATTEMPTS,
): Promise<StaleCommandRecoveryResult> {
  const { rows: requeuedRows } = await pool.query<PassportOperatorCommandRow>(
    `UPDATE passport_operator_commands
     SET status = 'pending'
     WHERE status = 'processing'
       AND updated_at < now() - ($1 * interval '1 minute')
       AND attempts < $2
     RETURNING ${SELECT_COLUMNS}`,
    [timeoutMinutes, maxAttempts],
  );

  const { rows: failedRows } = await pool.query<PassportOperatorCommandRow>(
    `UPDATE passport_operator_commands
     SET status = 'failed',
         last_error = 'gave up after exceeding max attempts following a stale/crashed operator-command processor'
     WHERE status = 'processing'
       AND updated_at < now() - ($1 * interval '1 minute')
       AND attempts >= $2
     RETURNING ${SELECT_COLUMNS}`,
    [timeoutMinutes, maxAttempts],
  );

  return { requeued: requeuedRows.map(mapRow), failed: failedRows.map(mapRow) };
}
