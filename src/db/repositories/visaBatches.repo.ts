import type { PoolClient } from 'pg';
import { pool } from '../pool.js';
import type { VisaBatch, VisaBatchApplicant, VisaBatchApplicantStatus, VisaBatchStatus, VisaPortal } from '../../visa/types.js';
import { retireApplicantWithConflictCheckWithClient } from './visaSubmissionQueue.repo.js';

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

export interface ActiveApplicantPosition {
  passportIdentityId: string;
  positionInBatch: number;
}

/**
 * Every ACTIVE applicant currently in this batch, ordered by their own
 * canonical position_in_batch -- the SAME column assignVisaBatch.ts itself
 * assigns on insert and never reassigns (see that file's own doc comment:
 * "A batch_number, once created, is NEVER reassigned or renumbered"; the
 * same stability applies to each row's own position_in_batch). Read-only,
 * no schema change -- added so a caller (the VisitSaudi submission
 * worker-loop) can verify a GIVEN applicant list is both complete and
 * correctly ordered against the batch's real membership before trusting
 * any list-position-derived signal (e.g. "is this the last applicant"),
 * rather than trusting the given list's own order blindly.
 */
export async function findActiveApplicantPositionsForBatch(batchId: string): Promise<ActiveApplicantPosition[]> {
  const { rows } = await pool.query<{ passport_identity_id: string; position_in_batch: number }>(
    `SELECT passport_identity_id, position_in_batch FROM visa_batch_applicants
     WHERE batch_id = $1 AND status = 'active'
     ORDER BY position_in_batch ASC`,
    [batchId],
  );
  return rows.map((row) => ({ passportIdentityId: row.passport_identity_id, positionInBatch: row.position_in_batch }));
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
 * never opens its own connection/transaction. External signature and
 * Promise<void> return type unchanged by Package 5.6 -- any conflict found
 * is handled entirely internally (a durable alert, never a thrown error or
 * a value the caller must react to).
 *
 * A no-op (0 rows affected) when there was no active assignment at all,
 * which is the common case today (visa automation is Phase 1 only --
 * nothing has actually been assigned to a batch yet for most identities) --
 * never throws for that.
 *
 * Package 5.6: each matching assignment is now retired via
 * retireApplicantWithConflictCheckWithClient (visaSubmissionQueue.repo.ts)
 * -- same applicant-FIRST, queue-SECOND lock order and SUBMITTING-conflict/
 * alert behavior cancelWithConflictCheck already uses, closing the gap
 * Package 5.5's audit found (this function previously never looked at
 * visa_submission_queue at all). The matching ids are read in a fixed,
 * deterministic order (ORDER BY id) before any lock is taken, so multiple
 * matches (one per portal) are always processed in the same order on every
 * call -- no new lock-ordering ambiguity.
 */
export async function updateActiveAssignmentsStatusWithClient(
  client: PoolClient,
  groupId: string,
  passportIdentityId: string,
  status: Extract<VisaBatchApplicantStatus, 'cancelled' | 'removed'>,
): Promise<void> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM visa_batch_applicants WHERE group_id = $1 AND passport_identity_id = $2 AND status = 'active' ORDER BY id`,
    [groupId, passportIdentityId],
  );
  for (const row of rows) {
    await retireApplicantWithConflictCheckWithClient(
      client,
      row.id,
      status,
      `conflict detected while retiring visa_batch_applicant ${row.id} (group/identity state change)`,
    );
  }
}

/**
 * Transitions every ACTIVE visa assignment for passportIdentityId, across
 * EVERY group and portal -- the identity-merge counterpart of
 * updateActiveAssignmentsStatusWithClient above, which is scoped to one
 * group. Used only by mergeIdentitiesTransaction (applyIdentityStateChange.ts)
 * to retire the LOSER identity's active assignments when two identities are
 * merged (Package 5.6, Package 5.5's own "M1: retire" decision) -- the
 * survivor never automatically inherits or gets a new assignment; an
 * operator who wants the survivor batched runs /visa_assign explicitly,
 * same discipline MOVE_TO_GROUP's own hook already follows.
 *
 * Same lock order, same SUBMITTING-conflict/alert behavior, same
 * deterministic (ORDER BY id) processing order as
 * updateActiveAssignmentsStatusWithClient -- only the WHERE scope differs
 * (identity only, no group_id filter, since a merge's loser may hold active
 * assignments in several different groups at once).
 */
export async function retireAllActiveAssignmentsForIdentityWithClient(
  client: PoolClient,
  passportIdentityId: string,
  status: Extract<VisaBatchApplicantStatus, 'cancelled' | 'removed'>,
): Promise<void> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM visa_batch_applicants WHERE passport_identity_id = $1 AND status = 'active' ORDER BY id`,
    [passportIdentityId],
  );
  for (const row of rows) {
    await retireApplicantWithConflictCheckWithClient(
      client,
      row.id,
      status,
      `conflict detected while retiring visa_batch_applicant ${row.id} (identity merge, loser=${passportIdentityId})`,
    );
  }
}
