import type { VisaSubmissionStatus } from './visaSubmissionStatus.js';

/**
 * Abstract storage contracts this phase's orchestration logic is written
 * against, PLUS simple in-memory fake implementations for tests only.
 *
 * ====================================================================
 * DISCLOSED LIMITATION (read before trusting any test built on this file):
 * ====================================================================
 * Neither in-memory fake below proves real PostgreSQL-level atomicity.
 * Each fake's "atomic" operation is a single synchronous check-and-set
 * inside one async function body with NO `await` between the check and
 * the mutation -- which is race-free only because Node.js runs one
 * JavaScript call stack at a time: two `Promise.all`-launched calls into
 * the SAME fake instance still have their synchronous bodies run to
 * completion one after another, never interleaved. That is a genuine,
 * useful guarantee for testing THIS PHASE'S OWN ORCHESTRATION LOGIC (does
 * it correctly handle a "not claimable" result? does it ever act on a
 * stale claim?) -- but it is NOT equivalent to, and does NOT demonstrate,
 * the cross-PROCESS mutual exclusion that a real deployment needs (two
 * separate `visa:worker` processes, or a worker and an operator-triggered
 * command, racing for the same row from two separate database
 * connections). That guarantee can only come from the database itself
 * (a single `UPDATE ... WHERE status = $expected` statement relying on
 * Postgres's own row-level locking -- exactly the pattern already proven
 * elsewhere in this codebase: sheetSyncQueue.repo.ts's markSheetSyncStarted,
 * assignVisaBatch.ts's unique-index-backed retry loop) and can only be
 * verified by testing against a real database, which this phase explicitly
 * does not do. A real implementation of VisaSubmissionQueueStore/
 * VisaBatchLockStore (a future, separately-approved migration) MUST use
 * that same single-atomic-UPDATE pattern, not merely mimic this fake's
 * shape.
 */

export interface VisaSubmissionRecord {
  id: string;
  groupId: string;
  batchId: string;
  passportIdentityId: string;
  status: VisaSubmissionStatus;
  /** Set when entering SUBMITTING; cleared (null) in every other status. */
  claimedAtMs: number | null;
  detail?: string;
}

export type AtomicTransitionOutcome =
  | { outcome: 'transitioned'; record: VisaSubmissionRecord }
  | { outcome: 'current-status-mismatch'; record: VisaSubmissionRecord }
  | { outcome: 'record-not-found' };

export interface VisaSubmissionQueueStore {
  createRecord(input: { groupId: string; batchId: string; passportIdentityId: string }): Promise<VisaSubmissionRecord>;
  getRecord(recordId: string): Promise<VisaSubmissionRecord | null>;
  findByApplicant(groupId: string, batchId: string, passportIdentityId: string): Promise<VisaSubmissionRecord | null>;
  /**
   * The ONE primitive every status change in this phase goes through:
   * succeeds ONLY if the record's CURRENT status is exactly
   * expectedCurrentStatus at the moment of the (conceptually indivisible)
   * check-and-set; otherwise reports the mismatch (or that the record does
   * not exist) without changing anything. `nowMs` is accepted explicitly
   * (never read internally via Date.now()) so tests can drive a fake clock
   * deterministically -- same convention as runSheetSyncLoop.ts's own
   * injectable `now`.
   */
  atomicTransition(recordId: string, expectedCurrentStatus: VisaSubmissionStatus, nextStatus: VisaSubmissionStatus, nowMs: number): Promise<AtomicTransitionOutcome>;
  /** Every record currently SUBMITTING whose claimedAtMs is older than staleAfterMs, as of nowMs. */
  findStaleSubmitting(staleAfterMs: number, nowMs: number): Promise<VisaSubmissionRecord[]>;
}

interface MutableRecord extends VisaSubmissionRecord {}

/** Optional injectable failure, for tests that need to prove a store-level failure is surfaced, never hidden or silently retried. */
export interface InMemoryStoreFailureInjection {
  throwOn?: 'createRecord' | 'getRecord' | 'findByApplicant' | 'atomicTransition' | 'findStaleSubmitting';
  error?: Error;
}

/**
 * See this file's own top-of-file DISCLOSED LIMITATION -- for tests only,
 * never a stand-in for a real database-backed implementation.
 */
export function buildInMemoryVisaSubmissionQueueStore(failure?: InMemoryStoreFailureInjection): VisaSubmissionQueueStore {
  const records = new Map<string, MutableRecord>();
  let nextId = 1;

  function maybeThrow(op: InMemoryStoreFailureInjection['throwOn']): void {
    if (failure?.throwOn === op) {
      throw failure?.error ?? new Error(`simulated failure in ${op}`);
    }
  }

  return {
    async createRecord(input) {
      maybeThrow('createRecord');
      const record: MutableRecord = {
        id: `record-${nextId}`,
        groupId: input.groupId,
        batchId: input.batchId,
        passportIdentityId: input.passportIdentityId,
        status: 'PENDING',
        claimedAtMs: null,
      };
      nextId += 1;
      records.set(record.id, record);
      return { ...record };
    },

    async getRecord(recordId) {
      maybeThrow('getRecord');
      const record = records.get(recordId);
      return record ? { ...record } : null;
    },

    async findByApplicant(groupId, batchId, passportIdentityId) {
      maybeThrow('findByApplicant');
      for (const record of records.values()) {
        if (record.groupId === groupId && record.batchId === batchId && record.passportIdentityId === passportIdentityId) {
          return { ...record };
        }
      }
      return null;
    },

    // No `await` appears before the mutation below -- see this file's own
    // DISCLOSED LIMITATION on exactly what that does and does not prove.
    async atomicTransition(recordId, expectedCurrentStatus, nextStatus, nowMs) {
      maybeThrow('atomicTransition');
      const record = records.get(recordId);
      if (!record) {
        return { outcome: 'record-not-found' };
      }
      if (record.status !== expectedCurrentStatus) {
        return { outcome: 'current-status-mismatch', record: { ...record } };
      }
      record.status = nextStatus;
      record.claimedAtMs = nextStatus === 'SUBMITTING' ? nowMs : null;
      return { outcome: 'transitioned', record: { ...record } };
    },

    async findStaleSubmitting(staleAfterMs, nowMs) {
      maybeThrow('findStaleSubmitting');
      const stale: VisaSubmissionRecord[] = [];
      for (const record of records.values()) {
        if (record.status === 'SUBMITTING' && record.claimedAtMs !== null && nowMs - record.claimedAtMs >= staleAfterMs) {
          stale.push({ ...record });
        }
      }
      return stale;
    },
  };
}

// --------------------------------------------------------------------
// Batch-level lock -- a SEPARATE concern from per-applicant claiming
// above. Per-applicant atomicTransition already prevents two processes
// from double-claiming the SAME applicant; a batch lock exists for a
// DIFFERENT reason: a future real automation step (Phase 2e) will drive
// ONE browser session through an entire "Group application" batch, and
// two such sessions racing for the same batch is wasteful/unsafe at the
// BROWSER level even though each individual applicant claim would still,
// independently, resolve safely.
// --------------------------------------------------------------------

export interface AcquireBatchLockResult {
  outcome: 'acquired' | 'already-locked';
  lockedBy?: string;
}

export interface ReleaseBatchLockResult {
  outcome: 'released' | 'not-holder' | 'not-locked';
}

export interface ForceReleaseBatchLockResult {
  outcome: 'released' | 'not-matched';
}

export interface BatchLockRecord {
  batchId: string;
  lockedBy: string;
  lockedAtMs: number;
}

export interface VisaBatchLockStore {
  acquireLock(batchId: string, lockedBy: string, nowMs: number): Promise<AcquireBatchLockResult>;
  releaseLock(batchId: string, lockedBy: string): Promise<ReleaseBatchLockResult>;
  findStaleLocks(staleAfterMs: number, nowMs: number): Promise<BatchLockRecord[]>;
  /**
   * Package 5.22: used only by stale-lock recovery -- force-clears a lock
   * presumed abandoned by a crashed worker, but ONLY if batchId/lockedBy/
   * lockedAtMs still EXACTLY match the lock findStaleLocks itself observed
   * (see forceReleaseBatchProcessingLock's own doc comment in
   * visaSubmissionQueue.repo.ts for why: the lock may have been legitimately
   * released and re-acquired by a DIFFERENT worker in the gap between the
   * staleness check and this call). 'not-matched' is not a failure -- it
   * means the lock already changed, so the CURRENT lock is correctly left
   * untouched; never retried, never logged as an error by the caller.
   */
  forceReleaseLock(batchId: string, lockedBy: string, lockedAtMs: number): Promise<ForceReleaseBatchLockResult>;
}

/**
 * See this file's own top-of-file DISCLOSED LIMITATION. Additionally,
 * specific to a batch lock: this in-memory fake only prevents parallel
 * starts WITHIN ONE PROCESS/test run. A real deployment needs this backed
 * by an actual database constraint or advisory lock (e.g. a UNIQUE-
 * constrained lock row, the same idiom visa_batches' own
 * (group_id, portal, batch_number) UNIQUE index already uses, or
 * Postgres's own pg_advisory_lock) -- never just an in-process Map like
 * this one, which offers no protection at all across separate worker
 * processes.
 */
export function buildInMemoryVisaBatchLockStore(): VisaBatchLockStore {
  const locks = new Map<string, BatchLockRecord>();

  return {
    async acquireLock(batchId, lockedBy, nowMs) {
      const existing = locks.get(batchId);
      if (existing) {
        return { outcome: 'already-locked', lockedBy: existing.lockedBy };
      }
      locks.set(batchId, { batchId, lockedBy, lockedAtMs: nowMs });
      return { outcome: 'acquired' };
    },

    async releaseLock(batchId, lockedBy) {
      const existing = locks.get(batchId);
      if (!existing) {
        return { outcome: 'not-locked' };
      }
      if (existing.lockedBy !== lockedBy) {
        return { outcome: 'not-holder' };
      }
      locks.delete(batchId);
      return { outcome: 'released' };
    },

    async findStaleLocks(staleAfterMs, nowMs) {
      const stale: BatchLockRecord[] = [];
      for (const lock of locks.values()) {
        if (nowMs - lock.lockedAtMs >= staleAfterMs) {
          stale.push({ ...lock });
        }
      }
      return stale;
    },

    async forceReleaseLock(batchId, lockedBy, lockedAtMs) {
      const existing = locks.get(batchId);
      if (!existing || existing.lockedBy !== lockedBy || existing.lockedAtMs !== lockedAtMs) {
        return { outcome: 'not-matched' };
      }
      locks.delete(batchId);
      return { outcome: 'released' };
    },
  };
}
