import {
  countActiveApplicantsInBatch,
  createVisaBatch,
  createVisaBatchAssignment,
  findActiveAssignment,
  findFreePositionInBatch,
  findLastBatchForGroup,
} from '../db/repositories/visaBatches.repo.js';
import { buildVisaBatchName } from './buildVisaBatchName.js';
import type { VisaBatchApplicant, VisaPortal } from './types.js';

const MAX_BATCH_SIZE = 10;
/** Same shared-attempt-budget convention as MAX_RECONCILIATION_ATTEMPTS elsewhere in this codebase -- real-world concurrency here is a handful of workers at most, never thousands. */
const MAX_ASSIGNMENT_ATTEMPTS = 5;

export interface AssignVisaBatchDependencies {
  findActiveAssignment: typeof findActiveAssignment;
  findLastBatchForGroup: typeof findLastBatchForGroup;
  countActiveApplicantsInBatch: typeof countActiveApplicantsInBatch;
  findFreePositionInBatch: typeof findFreePositionInBatch;
  createVisaBatch: typeof createVisaBatch;
  createVisaBatchAssignment: typeof createVisaBatchAssignment;
}

const defaultDependencies: AssignVisaBatchDependencies = {
  findActiveAssignment,
  findLastBatchForGroup,
  countActiveApplicantsInBatch,
  findFreePositionInBatch,
  createVisaBatch,
  createVisaBatchAssignment,
};

/** Postgres' own unique_violation SQLSTATE -- see pg's own error.code convention, already relied on implicitly elsewhere in this codebase's ON CONFLICT-guarded inserts. */
const POSTGRES_UNIQUE_VIOLATION = '23505';

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === POSTGRES_UNIQUE_VIOLATION;
}

/**
 * Idempotently assigns ONE applicant to a batch of at most 10 ACTIVE
 * applicants each. Only ever called for portal='visitsaudi' -- KSA Visa
 * never batches at all (see ksaVisaPackageBuilder.ts), one applicant per
 * package, independently of this function entirely.
 *
 * A batch_number, once created, is NEVER reassigned or renumbered: this
 * function only ever either (a) adds to the single most-recent PENDING
 * batch if it still has room, or (b) creates a brand-new batch one number
 * higher. An applicant whose assignment already exists (active) is always
 * returned as-is on the very first check, before anything else runs --
 * calling this twice for the same (group, identity, portal) is always a
 * safe no-op.
 *
 * Race-safety: every actual mutation goes through a DB constraint
 * (idx_visa_batch_applicants_one_active_assignment,
 * idx_visa_batch_applicants_position_active, and visa_batches'
 * (group_id, portal, batch_number) UNIQUE) that can reject a conflicting
 * concurrent attempt even if two callers both passed this function's own
 * application-level checks at the same time. A rejected attempt is not an
 * error to the caller -- it triggers a bounded retry with a fresh read, so
 * two workers racing to assign the same applicant always converge on the
 * SAME single assignment, and two workers racing to open the 11th slot
 * always converge on exactly one new batch being created.
 */
export async function assignVisaBatch(
  groupId: string,
  passportIdentityId: string,
  portal: VisaPortal,
  departureDateIso: string,
  deps: AssignVisaBatchDependencies = defaultDependencies,
): Promise<VisaBatchApplicant> {
  const existing = await deps.findActiveAssignment(groupId, passportIdentityId, portal);
  if (existing) {
    return existing;
  }

  for (let attempt = 0; attempt < MAX_ASSIGNMENT_ATTEMPTS; attempt += 1) {
    const lastBatch = await deps.findLastBatchForGroup(groupId, portal);

    let targetBatchId: string | null = null;

    if (lastBatch && lastBatch.status === 'pending') {
      const activeCount = await deps.countActiveApplicantsInBatch(lastBatch.id);
      if (activeCount < MAX_BATCH_SIZE) {
        targetBatchId = lastBatch.id;
      }
    }

    if (targetBatchId === null) {
      const nextBatchNumber = (lastBatch?.batchNumber ?? 0) + 1;
      try {
        const batch = await deps.createVisaBatch({
          groupId,
          portal,
          batchNumber: nextBatchNumber,
          batchName: buildVisaBatchName(departureDateIso, nextBatchNumber),
        });
        targetBatchId = batch.id;
      } catch (error) {
        if (isUniqueViolation(error)) {
          continue; // another caller already created this batch_number -- retry with a fresh read
        }
        throw error;
      }
    }

    const position = await deps.findFreePositionInBatch(targetBatchId);
    if (position === null) {
      continue; // the batch filled up between our count and now -- retry (will open a new batch)
    }

    const result = await deps.createVisaBatchAssignment({
      batchId: targetBatchId,
      groupId,
      passportIdentityId,
      portal,
      positionInBatch: position,
    });

    if (result.outcome === 'inserted') {
      return result.assignment;
    }

    // 'already_active': a concurrent caller assigned THIS SAME identity
    // first -- its row now exists, return it instead of creating a duplicate.
    const winner = await deps.findActiveAssignment(groupId, passportIdentityId, portal);
    if (winner) {
      return winner;
    }
  }

  throw new Error(
    `assignVisaBatch: could not assign (group=${groupId}, identity=${passportIdentityId}, portal=${portal}) after ${MAX_ASSIGNMENT_ATTEMPTS} attempts`,
  );
}
