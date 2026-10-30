import { canTransition, type VisaSubmissionStatus } from './visaSubmissionStatus.js';
import type {
  VisaBatchLockStore,
  VisaSubmissionQueueStore,
  VisaSubmissionRecord,
} from './visaSubmissionQueueStore.js';

/**
 * Same order-of-magnitude concern as STALE_SYNCING_TIMEOUT_MINUTES
 * (sheetSyncQueue.repo.ts) -- a crashed worker can leave a record stuck
 * mid-processing. Not reusing that exact constant: a VisitSaudi portal
 * round-trip (form fill, SAVE, page transition) may legitimately take
 * longer than one Sheets API call, so this phase keeps its own, separate
 * value rather than silently inheriting an unrelated file's tuning.
 */
export const STALE_SUBMITTING_TIMEOUT_MINUTES = 10;

export type RequestTransitionResult =
  | { ok: true; record: VisaSubmissionRecord }
  | { ok: false; reason: 'INVALID_CURRENT_STATUS' | 'INVALID_NEXT_STATUS' | 'FORBIDDEN_TRANSITION' | 'CURRENT_STATUS_MISMATCH' | 'RECORD_NOT_FOUND' };

/**
 * Every status change in this phase goes through here -- never directly
 * through a store's own atomicTransition. Validates the transition against
 * visaSubmissionStatus.ts's rule table FIRST: a caller can never force an
 * invalid transition through this function even if some future store
 * implementation would otherwise allow it.
 */
export async function requestTransition(
  store: VisaSubmissionQueueStore,
  recordId: string,
  from: VisaSubmissionStatus,
  to: VisaSubmissionStatus,
  nowMs: number,
): Promise<RequestTransitionResult> {
  const check = canTransition(from, to);
  if (!check.ok) {
    return { ok: false, reason: check.reason };
  }

  const outcome = await store.atomicTransition(recordId, from, to, nowMs);
  if (outcome.outcome === 'record-not-found') {
    return { ok: false, reason: 'RECORD_NOT_FOUND' };
  }
  if (outcome.outcome === 'current-status-mismatch') {
    return { ok: false, reason: 'CURRENT_STATUS_MISMATCH' };
  }
  return { ok: true, record: outcome.record };
}

/**
 * Attempts to claim exactly ONE applicant record for submission processing
 * (PENDING -> SUBMITTING). Adds no locking of its own beyond what the
 * store's atomicTransition already guarantees -- mirrors assignVisaBatch.ts's
 * own reliance on a storage-level guarantee rather than an application-level
 * lock. See visaSubmissionQueueStore.ts's own DISCLOSED LIMITATION for what
 * this function's own tests can and cannot prove about real concurrency.
 */
export async function claimApplicantForSubmission(
  store: VisaSubmissionQueueStore,
  recordId: string,
  nowMs: number,
): Promise<RequestTransitionResult> {
  return requestTransition(store, recordId, 'PENDING', 'SUBMITTING', nowMs);
}

/**
 * Transitions a claimed (SUBMITTING) applicant to its final outcome. The
 * caller decides SAVED vs ERROR vs AMBIGUOUS based on what the (future,
 * real) portal-automation step actually observed -- this function only
 * enforces that the transition is legal and atomic; it has no opinion of
 * its own about what "a reliable save signal" looks like on the real
 * portal (that is Phase 2e's job).
 */
export async function finalizeApplicantSubmission(
  store: VisaSubmissionQueueStore,
  recordId: string,
  outcome: 'SAVED' | 'ERROR' | 'AMBIGUOUS' | 'AWAITING_MANUAL_CONTINUATION',
  nowMs: number,
): Promise<RequestTransitionResult> {
  return requestTransition(store, recordId, 'SUBMITTING', outcome, nowMs);
}

export interface RecoverStaleSubmittingResult {
  movedToAmbiguous: VisaSubmissionRecord[];
  /** Records findStaleSubmitting reported as stale, but whose transition no longer succeeded by the time this ran (e.g. it legitimately finished -- SAVED/ERROR -- in the gap between the two calls). Not an error -- a lost race against a real finish, never retried, never logged as a failure. */
  lostRaceAgainstFinish: string[];
  /** A truly unexpected per-record failure (e.g. the store threw) -- captured so one bad record never aborts the sweep for the rest. */
  unexpectedFailures: Array<{ recordId: string; detail: string }>;
}

/**
 * Sweeps every SUBMITTING record whose claim is older than
 * STALE_SUBMITTING_TIMEOUT_MINUTES and moves it to AMBIGUOUS -- NEVER back
 * to PENDING (see visaSubmissionStatus.ts's own doc comment for why: a
 * SUBMITTING record abandoned by a crashed worker means "we no longer know
 * whether the portal actually saved this applicant," and resubmitting it
 * blind risks a duplicate application).
 *
 * One record's unexpected failure never aborts the sweep for the rest --
 * same per-item try/catch convention as visaAssignCommand.ts's own loop
 * and runSheetSyncLoop.ts's own per-job try/catch.
 */
export async function recoverStaleSubmittingToAmbiguous(
  store: VisaSubmissionQueueStore,
  nowMs: number,
  staleAfterMs: number = STALE_SUBMITTING_TIMEOUT_MINUTES * 60_000,
): Promise<RecoverStaleSubmittingResult> {
  const result: RecoverStaleSubmittingResult = { movedToAmbiguous: [], lostRaceAgainstFinish: [], unexpectedFailures: [] };

  let stale: VisaSubmissionRecord[];
  try {
    stale = await store.findStaleSubmitting(staleAfterMs, nowMs);
  } catch (error) {
    // A failure just finding candidates is systemic (e.g. the store/DB
    // itself is unreachable) -- propagate, mirroring runSheetSyncLoop.ts's
    // own policy for its findDue()/reconcile() calls.
    throw error;
  }

  for (const record of stale) {
    try {
      const transition = await requestTransition(store, record.id, 'SUBMITTING', 'AMBIGUOUS', nowMs);
      if (transition.ok) {
        result.movedToAmbiguous.push(transition.record);
      } else {
        result.lostRaceAgainstFinish.push(record.id);
      }
    } catch (error) {
      result.unexpectedFailures.push({ recordId: record.id, detail: error instanceof Error ? error.message : 'unknown error' });
    }
  }

  return result;
}

// --------------------------------------------------------------------
// Batch-level lock orchestration (see visaSubmissionQueueStore.ts's own
// VisaBatchLockStore doc comment for why this is a separate concern from
// per-applicant claiming above, and for its own disclosed limitation).
// --------------------------------------------------------------------

export async function acquireBatchProcessingLock(store: VisaBatchLockStore, batchId: string, workerId: string, nowMs: number) {
  return store.acquireLock(batchId, workerId, nowMs);
}

export async function releaseBatchProcessingLock(store: VisaBatchLockStore, batchId: string, workerId: string) {
  return store.releaseLock(batchId, workerId);
}

export interface RecoverStaleBatchLocksResult {
  released: string[];
  /**
   * Package 5.22: a lock findStaleLocks reported as stale, but which no
   * longer EXACTLY matched (batchId + lockedBy + lockedAtMs) by the time
   * forceReleaseLock ran -- e.g. the original holder released normally
   * and a different worker already re-acquired it in that gap (see
   * forceReleaseLock's own doc comment for why an exact match matters).
   * Not an error -- never retried, never logged as a failure; the lock
   * that is CURRENTLY there (whatever it now is) is correctly left
   * untouched.
   */
  alreadyChanged: string[];
  unexpectedFailures: Array<{ batchId: string; detail: string }>;
}

/**
 * Force-releases every batch lock abandoned by a crashed worker. Unlike
 * recoverStaleSubmittingToAmbiguous's own applicant-level rule, a stale
 * BATCH lock is safe to simply release (not move to some "ambiguous lock"
 * state) -- the lock itself carries no submission outcome, it only ever
 * gated which worker was allowed to iterate the batch; releasing it just
 * lets the NEXT acquisition attempt succeed. Each individual applicant's
 * own status (claimed via the separate per-applicant store) is untouched
 * by this and still protected by its own stale-SUBMITTING recovery.
 *
 * Package 5.22: passes the FULL lock identity (batchId, lockedBy,
 * lockedAtMs) this function already has from findStaleLocks into
 * forceReleaseLock, so a lock that changed between the two calls is never
 * force-released out from under its new, legitimate holder -- see
 * forceReleaseLock's own doc comment (visaSubmissionQueueStore.ts) for the
 * exact race this closes.
 */
export async function recoverStaleBatchLocks(
  store: VisaBatchLockStore,
  nowMs: number,
  staleAfterMs: number = STALE_SUBMITTING_TIMEOUT_MINUTES * 60_000,
): Promise<RecoverStaleBatchLocksResult> {
  const stale = await store.findStaleLocks(staleAfterMs, nowMs);
  const released: string[] = [];
  const alreadyChanged: string[] = [];
  const unexpectedFailures: Array<{ batchId: string; detail: string }> = [];

  for (const lock of stale) {
    try {
      const result = await store.forceReleaseLock(lock.batchId, lock.lockedBy, lock.lockedAtMs);
      if (result.outcome === 'released') {
        released.push(lock.batchId);
      } else {
        alreadyChanged.push(lock.batchId);
      }
    } catch (error) {
      unexpectedFailures.push({ batchId: lock.batchId, detail: error instanceof Error ? error.message : 'unknown error' });
    }
  }

  return { released, alreadyChanged, unexpectedFailures };
}
