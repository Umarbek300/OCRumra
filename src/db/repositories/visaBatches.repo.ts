import type { PoolClient } from 'pg';
import { pool } from '../pool.js';
import type { VisaBatch, VisaBatchApplicant, VisaBatchApplicantStatus, VisaBatchStatus, VisaPortal } from '../../visa/types.js';

interface VisaBatchRow {
  id: string;
  group_id: string;
  portal: VisaPortal;
  batch_number: number;
  batch_name: string;
  status: VisaBatchStatus;
  created_at: string;
  updated_at: string;
}

interface VisaBatchApplicantRow {
  id: string;
  batch_id: string;
  group_id: string;
  passport_identity_id: string;
  portal: VisaPortal;
  position_in_batch: number;
  status: VisaBatchApplicantStatus;
  created_at: string;
  updated_at: string;
}

function mapBatch(row: VisaBatchRow): VisaBatch {
  return {
    id: row.id,
    groupId: row.group_id,
    portal: row.portal,
    batchNumber: row.batch_number,
    batchName: row.batch_name,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapApplicant(row: VisaBatchApplicantRow): VisaBatchApplicant {
  return {
    id: row.id,
    batchId: row.batch_id,
    groupId: row.group_id,
    passportIdentityId: row.passport_identity_id,
    portal: row.portal,
    positionInBatch: row.position_in_batch,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const BATCH_COLUMNS = 'id, group_id, portal, batch_number, batch_name, status, created_at, updated_at';
const APPLICANT_COLUMNS = 'id, batch_id, group_id, passport_identity_id, portal, position_in_batch, status, created_at, updated_at';

/** The active assignment (if any) for this (group, identity, portal) -- see idx_visa_batch_applicants_one_active_assignment, the DB-level backstop this query mirrors at the application level. */
export async function findActiveAssignment(
  groupId: string,
  passportIdentityId: string,
  portal: VisaPortal,
): Promise<VisaBatchApplicant | null> {
  const { rows } = await pool.query<VisaBatchApplicantRow>(
    `SELECT ${APPLICANT_COLUMNS} FROM visa_batch_applicants
     WHERE group_id = $1 AND passport_identity_id = $2 AND portal = $3 AND status = 'active'`,
    [groupId, passportIdentityId, portal],
  );
  const row = rows[0];
  return row ? mapApplicant(row) : null;
}

/** A batch by its own id -- used by callers (e.g. visaAssignCommand.ts) that already hold a VisaBatchApplicant and need its batch's own batchName/status for reporting, without relying on "the last batch" as a proxy (which is only guaranteed correct for the single most recent assignment in a group, not for an arbitrary earlier one). */
export async function findVisaBatchById(id: string): Promise<VisaBatch | null> {
  const { rows } = await pool.query<VisaBatchRow>(`SELECT ${BATCH_COLUMNS} FROM visa_batches WHERE id = $1`, [id]);
  const row = rows[0];
  return row ? mapBatch(row) : null;
}

/** The most recently created batch for this (group, portal) -- the only one a new applicant could still be added to. */
export async function findLastBatchForGroup(groupId: string, portal: VisaPortal): Promise<VisaBatch | null> {
  const { rows } = await pool.query<VisaBatchRow>(
    `SELECT ${BATCH_COLUMNS} FROM visa_batches
     WHERE group_id = $1 AND portal = $2
     ORDER BY batch_number DESC
     LIMIT 1`,
    [groupId, portal],
  );
  const row = rows[0];
  return row ? mapBatch(row) : null;
}

export async function countActiveApplicantsInBatch(batchId: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM visa_batch_applicants WHERE batch_id = $1 AND status = 'active'`,
    [batchId],
  );
  return Number(rows[0]?.count ?? '0');
}

/** The lowest 1..10 position not currently held by an active applicant in this batch, or null if all 10 are taken. */
export async function findFreePositionInBatch(batchId: string): Promise<number | null> {
  const { rows } = await pool.query<{ position_in_batch: number }>(
    `SELECT position_in_batch FROM visa_batch_applicants WHERE batch_id = $1 AND status = 'active'`,
    [batchId],
  );
  const taken = new Set(rows.map((row) => row.position_in_batch));
  for (let position = 1; position <= 10; position += 1) {
    if (!taken.has(position)) return position;
  }
  return null;
}

export async function createVisaBatch(input: {
  groupId: string;
  portal: VisaPortal;
  batchNumber: number;
  batchName: string;
}): Promise<VisaBatch> {
  const { rows } = await pool.query<VisaBatchRow>(
    `INSERT INTO visa_batches (group_id, portal, batch_number, batch_name)
     VALUES ($1,$2,$3,$4)
     RETURNING ${BATCH_COLUMNS}`,
    [input.groupId, input.portal, input.batchNumber, input.batchName],
  );
  const row = rows[0];
  if (!row) throw new Error('createVisaBatch: insert returned no row');
  return mapBatch(row);
}

export type CreateVisaBatchAssignmentResult = { outcome: 'inserted'; assignment: VisaBatchApplicant } | { outcome: 'already_active' };

/**
 * ON CONFLICT targets idx_visa_batch_applicants_one_active_assignment
 * directly -- the DB-level guarantee that a duplicate assignment for an
 * already-active (group, identity, portal) can never be inserted, even if
 * two callers raced past assignVisaBatch.ts's own application-level
 * findActiveAssignment check at the same time.
 */
export async function createVisaBatchAssignment(input: {
  batchId: string;
  groupId: string;
  passportIdentityId: string;
  portal: VisaPortal;
  positionInBatch: number;
}): Promise<CreateVisaBatchAssignmentResult> {
  const { rows } = await pool.query<VisaBatchApplicantRow>(
    `INSERT INTO visa_batch_applicants (batch_id, group_id, passport_identity_id, portal, position_in_batch)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (group_id, passport_identity_id, portal) WHERE status = 'active' DO NOTHING
     RETURNING ${APPLICANT_COLUMNS}`,
    [input.batchId, input.groupId, input.passportIdentityId, input.portal, input.positionInBatch],
  );
  const row = rows[0];
  return row ? { outcome: 'inserted', assignment: mapApplicant(row) } : { outcome: 'already_active' };
}

export async function updateBatchStatus(batchId: string, status: VisaBatchStatus): Promise<VisaBatch | null> {
  const { rows } = await pool.query<VisaBatchRow>(`UPDATE visa_batches SET status = $2 WHERE id = $1 RETURNING ${BATCH_COLUMNS}`, [
    batchId,
    status,
  ]);
  const row = rows[0];
  return row ? mapBatch(row) : null;
}

/**
 * Transitions every ACTIVE visa assignment for (groupId, passportIdentityId)
 * -- across every portal, since a /remove or CANCEL_PASSPORT applies to the
 * whole (identity, group) pair, not to one portal's assignment alone -- to
 * the given terminal status. Takes an explicit client so
 * applyIdentityStateChange.ts can call this INSIDE its own existing
 * transaction (same convention as insertReconciliationJobWithClient) --
 * never opens its own connection/transaction.
 *
 * A no-op (0 rows affected) when there was no active assignment at all,
 * which is the common case today (visa automation is Phase 1 only --
 * nothing has actually been assigned to a batch yet for most identities) --
 * never throws for that.
 */
export async function updateActiveAssignmentsStatusWithClient(
  client: PoolClient,
  groupId: string,
  passportIdentityId: string,
  status: Extract<VisaBatchApplicantStatus, 'cancelled' | 'removed'>,
): Promise<void> {
  await client.query(
    `UPDATE visa_batch_applicants SET status = $3
     WHERE group_id = $1 AND passport_identity_id = $2 AND status = 'active'`,
    [groupId, passportIdentityId, status],
  );
}
