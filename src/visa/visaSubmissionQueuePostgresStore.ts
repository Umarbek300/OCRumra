import { pool } from '../db/pool.js';
import { findActiveAssignment } from '../db/repositories/visaBatches.repo.js';
import {
  acquireBatchProcessingLock,
  atomicTransition,
  createSingleQueueRecord,
  findBatchProcessingLock,
  findQueueRecordByApplicantId,
  findQueueRecordById,
  findStaleBatchProcessingLocks,
  findStaleSubmitting,
  forceReleaseBatchProcessingLock,
  releaseBatchProcessingLock,
  type VisaSubmissionQueueRecord,
} from '../db/repositories/visaSubmissionQueue.repo.js';
import type {
  AcquireBatchLockResult,
  AtomicTransitionOutcome,
  BatchLockRecord,
  ReleaseBatchLockResult,
  VisaBatchLockStore,
  VisaSubmissionQueueStore,
  VisaSubmissionRecord,
} from './visaSubmissionQueueStore.js';

/**
 * ====================================================================
 * PostgreSQL-backed VisaSubmissionQueueStore / VisaBatchLockStore
 * ====================================================================
 * The real, cross-process implementation the in-memory fakes in
 * visaSubmissionQueueStore.ts explicitly disclaim being equivalent to.
 * visaSubmissionQueueOrchestrator.ts is UNCHANGED by this file -- it only
 * ever talks to the Store interfaces, never to Postgres directly, so its
 * own pure transition logic and its existing in-memory-backed tests are
 * unaffected.
 *
 * Interface/schema mismatch this adapter bridges, deliberately NOT papered
 * over silently: VisaSubmissionRecord is keyed by passportIdentityId (the
 * Store interface's own design), but visa_submission_queue
 * (migrations/0028) is keyed by visa_batch_applicant_id -- the PRIMARY,
 * real creation path for a whole batch is createQueueForBatch
 * (visaSubmissionQueue.repo.ts), called ONCE per batch, atomically, for
 * every active applicant at once; it does NOT go through this Store's
 * createRecord at all. createRecord/getRecord/findByApplicant below exist
 * only to satisfy the VisaSubmissionQueueStore contract for a SECONDARY,
 * single-applicant path, and resolve passportIdentityId <-> visa_batch_applicant_id
 * via visaBatches.repo.ts's own findActiveAssignment (a lookup, never a
 * write) plus a direct, local read of visa_batch_applicants.passport_identity_id --
 * added here rather than to visaBatches.repo.ts, to keep this round's
 * change contained to the two files it was scoped to.
 */

async function findApplicantPassportIdentityId(visaBatchApplicantId: string): Promise<string | null> {
  const { rows } = await pool.query<{ passport_identity_id: string }>(
    `SELECT passport_identity_id FROM visa_batch_applicants WHERE id = $1`,
    [visaBatchApplicantId],
  );
  return rows[0]?.passport_identity_id ?? null;
}

async function toVisaSubmissionRecord(record: VisaSubmissionQueueRecord): Promise<VisaSubmissionRecord> {
  const passportIdentityId = await findApplicantPassportIdentityId(record.visaBatchApplicantId);
  if (!passportIdentityId) {
    throw new Error(
      `visaSubmissionQueuePostgresStore: no visa_batch_applicants row found for visa_batch_applicant_id ${record.visaBatchApplicantId}`,
    );
  }
  return {
    id: record.id,
    groupId: record.groupId,
    batchId: record.batchId,
    passportIdentityId,
    status: record.status,
    claimedAtMs: record.claimedAt ? new Date(record.claimedAt).getTime() : null,
    detail: record.lastError ?? undefined,
  };
}

/** KSA Visa never batches/queues through this feature at all (see ksaVisaPackageBuilder.ts) -- every lookup here is deliberately narrowed to 'visitsaudi', same as assignVisaBatch.ts's own portal parameter. */
const PORTAL = 'visitsaudi' as const;

export function buildPostgresVisaSubmissionQueueStore(): VisaSubmissionQueueStore {
  return {
    async createRecord(input) {
      const assignment = await findActiveAssignment(input.groupId, input.passportIdentityId, PORTAL);
      if (!assignment) {
        throw new Error(
          `buildPostgresVisaSubmissionQueueStore.createRecord: no active visa_batch_applicants assignment found for ` +
            `(group=${input.groupId}, identity=${input.passportIdentityId}, portal=${PORTAL})`,
        );
      }
      const record = await createSingleQueueRecord(assignment.id, input.batchId, input.groupId);
      return toVisaSubmissionRecord(record);
    },

    async getRecord(recordId) {
      const record = await findQueueRecordById(recordId);
      return record ? toVisaSubmissionRecord(record) : null;
    },

    async findByApplicant(groupId, _batchId, passportIdentityId) {
      const assignment = await findActiveAssignment(groupId, passportIdentityId, PORTAL);
      if (!assignment) {
        return null;
      }
      const record = await findQueueRecordByApplicantId(assignment.id);
      return record ? toVisaSubmissionRecord(record) : null;
    },

    async atomicTransition(recordId, expectedCurrentStatus, nextStatus, _nowMs): Promise<AtomicTransitionOutcome> {
      const outcome = await atomicTransition(recordId, expectedCurrentStatus, nextStatus);
      if (outcome.outcome === 'record-not-found') {
        return outcome;
      }
      return { outcome: outcome.outcome, record: await toVisaSubmissionRecord(outcome.record) };
    },

    async findStaleSubmitting(staleAfterMs, _nowMs) {
      const stale = await findStaleSubmitting(staleAfterMs);
      return Promise.all(stale.map(toVisaSubmissionRecord));
    },
  };
}

export function buildPostgresVisaBatchLockStore(): VisaBatchLockStore {
  return {
    async acquireLock(batchId, lockedBy, _nowMs): Promise<AcquireBatchLockResult> {
      const lock = await acquireBatchProcessingLock(batchId, lockedBy);
      if (lock) {
        return { outcome: 'acquired' };
      }
      const current = await findBatchProcessingLock(batchId);
      return { outcome: 'already-locked', lockedBy: current?.lockedBy };
    },

    async releaseLock(batchId, lockedBy): Promise<ReleaseBatchLockResult> {
      const outcome = await releaseBatchProcessingLock(batchId, lockedBy);
      return { outcome };
    },

    async findStaleLocks(staleAfterMs, _nowMs): Promise<BatchLockRecord[]> {
      const locks = await findStaleBatchProcessingLocks(staleAfterMs);
      return locks.map((lock) => ({
        batchId: lock.batchId,
        lockedBy: lock.lockedBy,
        lockedAtMs: new Date(lock.lockedAt).getTime(),
      }));
    },

    async forceReleaseLock(batchId, lockedBy, lockedAtMs) {
      const outcome = await forceReleaseBatchProcessingLock(batchId, lockedBy, lockedAtMs);
      return { outcome };
    },
  };
}
