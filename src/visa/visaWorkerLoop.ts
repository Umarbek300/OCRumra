import {
  acquireBatchProcessingLock,
  claimApplicantForSubmission,
  finalizeApplicantSubmission,
  releaseBatchProcessingLock,
} from './visaSubmissionQueueOrchestrator.js';
import type { VisaBatchLockStore, VisaSubmissionQueueStore } from './visaSubmissionQueueStore.js';
import type { VisaApplicantAutomationAdapter } from './visaApplicantAutomationAdapter.js';
import type { VisitSaudiPreflightResult } from './visitSaudiPreflight.js';

/**
 * Minimal, portal-free worker-loop for ONE batch, built entirely on
 * ALREADY-EXISTING primitives -- no new DB method beyond one pure,
 * read-only SELECT on the already-existing position_in_batch column
 * (visaBatches.repo.ts's findActiveApplicantPositionsForBatch, added
 * alongside this file in Package 5.1), no new repository, no new
 * architecture:
 *  - batch mutual exclusion: acquireBatchProcessingLock/releaseBatchProcessingLock
 *    (visaSubmissionQueueOrchestrator.ts, unchanged)
 *  - per-applicant claim/finalize: claimApplicantForSubmission/
 *    finalizeApplicantSubmission (same file, unchanged)
 *  - readiness: an injected checkPreflight (shaped exactly like
 *    checkVisitSaudiApplicantPreflight -- visitSaudiPreflight.ts,
 *    unchanged, never modified; a REAL caller passes that function
 *    itself, a test passes a trivial fake so no Sheet/network I/O ever
 *    runs in a test)
 *  - the actual "submit" step: an injected VisaApplicantAutomationAdapter
 *    (visaApplicantAutomationAdapter.ts -- NEW this package, since no
 *    existing interface models a per-applicant save outcome; see that
 *    file's own doc comment)
 *
 * Deliberately has NO default dependencies object and performs NO lookup
 * of "which records are PENDING in this batch" on its own -- the caller
 * supplies the exact candidate list. Nothing here can accidentally reach
 * a real portal: there is no fallback automation adapter, and the only
 * things this module imports beyond pure types are the two orchestrator
 * functions above (DB-only, no network).
 *
 * ============================================================================
 * Package 5.1 hardening (Package 5.0 audit findings #1 and #2):
 * ============================================================================
 * 1. IDENTITY CROSS-CHECK: a caller-supplied {recordId, groupId,
 *    passportIdentityId} triple is no longer trusted blindly. Before
 *    claiming, processOneApplicant reads the record's OWN, real
 *    {groupId, batchId, passportIdentityId} via
 *    deps.queueStore.getRecord(recordId) (an already-existing Store
 *    method -- see visaSubmissionQueueStore.ts) and refuses to proceed
 *    (never claims, never calls preflight or automation) if any of the
 *    three disagree with what the caller supplied.
 * 2. BATCH COMPLETENESS/ORDER: isLastApplicantInBatch is no longer
 *    trusted from the given list's own length/order alone.
 *    runVisaWorkerLoopForBatch now verifies the given applicants list's
 *    passportIdentityIds are EXACTLY the batch's real active membership,
 *    in EXACTLY the batch's own canonical position_in_batch order
 *    (deps.findActiveApplicantPositions), BEFORE processing a single
 *    applicant. If the list is incomplete, contains a duplicate, contains
 *    an applicant from a different batch, or is out of order, automation
 *    is NEVER called for ANY applicant in that run.
 */

export interface VisaWorkerLoopApplicantInput {
  recordId: string;
  groupId: string;
  passportIdentityId: string;
}

/** The batch's real active membership, ordered by its own canonical position_in_batch -- shaped exactly like visaBatches.repo.ts's own ActiveApplicantPosition, redeclared locally so this module stays decoupled from that concrete repo file (a real caller passes findActiveApplicantPositionsForBatch itself; a test passes a deterministic fake). */
export interface VisaWorkerLoopActiveApplicantPosition {
  passportIdentityId: string;
  positionInBatch: number;
}

export type VisaWorkerLoopApplicantOutcome =
  /**
   * Package 5.41: `detail` is OPTIONAL and, when present, is PURELY
   * INFORMATIONAL -- it never changes this outcome away from 'SAVED' and
   * is never a reason to treat the save as having failed. It carries
   * exactly the same free-form diagnostic string
   * VisaApplicantAutomationResult.detail already carries for ERROR/
   * AMBIGUOUS (visaApplicantAutomationAdapter.ts's own doc comment: "same
   * convention as visa_submission_queue.last_error") -- e.g. the real
   * adapter (visitSaudiBrowserAutomationAdapter.ts) uses it to report
   * that a hotel-autocomplete suggestion was never found/selected, or
   * that Page 5 (Insurance) never appeared so its consent was never
   * confirmed. Before this package, this exact information was already
   * computed by the automation adapter but was SILENTLY DISCARDED here
   * (processOneApplicant's own SAVED branch used to return only
   * `{recordId, outcome: 'SAVED'}`, dropping `automationResult.detail`
   * entirely) -- closing that gap, not changing what SAVED means.
   */
  | { recordId: string; outcome: 'SAVED'; detail?: string }
  | { recordId: string; outcome: 'ERROR'; detail?: string }
  | { recordId: string; outcome: 'AMBIGUOUS'; detail?: string }
  /** Package [Page3->Page7 flow fix]: the automation adapter confirmed everything it is itself able to do for this applicant succeeded and has reached a KNOWN, EXPECTED human-handoff point (see visitSaudiBrowserAutomationAdapter.ts's own doc comment) -- never auto-resubmitted; an operator continues manually. */
  | { recordId: string; outcome: 'AWAITING_MANUAL_CONTINUATION'; detail?: string }
  /** claimApplicantForSubmission rejected the claim -- e.g. already SAVED/ERROR/AMBIGUOUS/SUBMITTING, or the record does not exist. Automation is NEVER called for a record the worker could not claim. */
  | { recordId: string; outcome: 'SKIPPED_NOT_CLAIMABLE'; reason: string }
  /** deps.queueStore.getRecord(recordId) found no record at all for the given recordId. Automation is NEVER called. */
  | { recordId: string; outcome: 'RECORD_NOT_FOUND' }
  /** The record genuinely exists, but its OWN real groupId/batchId/passportIdentityId does not match what the caller supplied for this recordId -- never claimed, never finalized, automation NEVER called. This is the Package 5.0 audit's "applicant/group identifiers never cross-checked" finding, now closed. */
  | { recordId: string; outcome: 'IDENTITY_MISMATCH'; reason: string }
  /** Preflight reported not-ready AFTER a successful claim -- automation is NEVER called. The record is deliberately left SUBMITTING (never reset to PENDING here); stale-recovery (recoverStaleSubmittingToAmbiguous) is the only path out, same as any other stall. */
  | { recordId: string; outcome: 'SKIPPED_PREFLIGHT_FAILED'; reason: string }
  /** The preflight check itself threw, the automation adapter threw, or finalize was unexpectedly rejected -- in every one of these cases the record is left exactly where it was (claimed/SUBMITTING if automation never resolved; whatever finalize actually did if finalize itself is what failed), SAVED is NEVER guessed, and no automatic resubmission happens. */
  | { recordId: string; outcome: 'UNEXPECTED_ERROR'; detail: string };

export type VisaWorkerLoopBatchValidation = { outcome: 'ok' } | { outcome: 'rejected'; reason: string };

export interface VisaWorkerLoopResult {
  lockOutcome: 'acquired' | 'already-locked';
  /** Only present when lockOutcome === 'acquired'. 'ok' means the given applicants list was verified complete and correctly ordered against the batch's real position_in_batch membership BEFORE any applicant was touched -- isLastApplicantInBatch is therefore trustworthy. 'rejected' means the list failed that check; NO applicant was processed at all (applicantOutcomes is empty, automation was never called for any of them). */
  batchValidation?: VisaWorkerLoopBatchValidation;
  applicantOutcomes: VisaWorkerLoopApplicantOutcome[];
}

export interface VisaWorkerLoopDependencies {
  queueStore: VisaSubmissionQueueStore;
  lockStore: VisaBatchLockStore;
  automation: VisaApplicantAutomationAdapter;
  /** Shaped exactly like checkVisitSaudiApplicantPreflight(groupId, passportIdentityId) -- a real caller passes that function itself (its own optional deps parameter is irrelevant here); a test passes a deterministic fake. */
  checkPreflight: (groupId: string, passportIdentityId: string) => Promise<VisitSaudiPreflightResult>;
  /** Shaped exactly like visaBatches.repo.ts's own findActiveApplicantPositionsForBatch(batchId) -- a real caller passes that function itself; a test passes a deterministic fake so no DB call is needed to exercise the validation logic in isolation. */
  findActiveApplicantPositions: (batchId: string) => Promise<VisaWorkerLoopActiveApplicantPosition[]>;
}

/**
 * Verifies the given applicants list is EXACTLY the batch's real active
 * membership (same passportIdentityIds, no duplicates, nothing missing,
 * nothing from a different batch) in EXACTLY the batch's own canonical
 * position_in_batch order. Never invents a new ordering rule -- compares
 * against position_in_batch, the same column assignVisaBatch.ts itself
 * assigns and never reassigns.
 */
function validateApplicantListAgainstBatch(
  applicants: readonly VisaWorkerLoopApplicantInput[],
  realPositions: readonly VisaWorkerLoopActiveApplicantPosition[],
): VisaWorkerLoopBatchValidation {
  const givenIds = applicants.map((a) => a.passportIdentityId);
  if (new Set(givenIds).size !== givenIds.length) {
    return { outcome: 'rejected', reason: 'the given applicants list contains a duplicate passportIdentityId' };
  }

  const realIds = realPositions.map((p) => p.passportIdentityId);
  if (givenIds.length !== realIds.length) {
    return {
      outcome: 'rejected',
      reason: `the given applicants list has ${givenIds.length} entr${givenIds.length === 1 ? 'y' : 'ies'}, but the batch's real active membership has ${realIds.length} -- the list is incomplete, has an extra entry, or includes an applicant from a different batch`,
    };
  }

  for (let i = 0; i < givenIds.length; i += 1) {
    if (givenIds[i] !== realIds[i]) {
      return {
        outcome: 'rejected',
        reason: `the given applicants list's order does not match the batch's real position_in_batch order at position ${i + 1}`,
      };
    }
  }

  return { outcome: 'ok' };
}

async function processOneApplicant(
  applicant: VisaWorkerLoopApplicantInput,
  batchId: string,
  isLastApplicantInBatch: boolean,
  deps: VisaWorkerLoopDependencies,
  nowMs: number,
): Promise<VisaWorkerLoopApplicantOutcome> {
  // Identity cross-check (Package 5.0 audit finding #1): the record's own,
  // real identifiers are read fresh from the store and compared against
  // what the caller supplied for this exact recordId -- BEFORE any claim,
  // preflight, or automation call. A caller-side bug that mismatches a
  // recordId with the wrong groupId/passportIdentityId (e.g. two
  // applicants' input objects swapped) is caught here, not trusted.
  const existingRecord = await deps.queueStore.getRecord(applicant.recordId);
  if (!existingRecord) {
    return { recordId: applicant.recordId, outcome: 'RECORD_NOT_FOUND' };
  }
  if (
    existingRecord.groupId !== applicant.groupId ||
    existingRecord.passportIdentityId !== applicant.passportIdentityId ||
    existingRecord.batchId !== batchId
  ) {
    return {
      recordId: applicant.recordId,
      outcome: 'IDENTITY_MISMATCH',
      reason: `recordId ${applicant.recordId}'s real (groupId=${existingRecord.groupId}, batchId=${existingRecord.batchId}, passportIdentityId=${existingRecord.passportIdentityId}) does not match the given (groupId=${applicant.groupId}, batchId=${batchId}, passportIdentityId=${applicant.passportIdentityId})`,
    };
  }

  const claim = await claimApplicantForSubmission(deps.queueStore, applicant.recordId, nowMs);
  if (!claim.ok) {
    return { recordId: applicant.recordId, outcome: 'SKIPPED_NOT_CLAIMABLE', reason: claim.reason };
  }

  let preflight: VisitSaudiPreflightResult;
  try {
    preflight = await deps.checkPreflight(applicant.groupId, applicant.passportIdentityId);
  } catch (error) {
    // Could not even determine readiness -- never finalize blind.
    return {
      recordId: applicant.recordId,
      outcome: 'UNEXPECTED_ERROR',
      detail: `preflight check threw: ${error instanceof Error ? error.message : 'unknown error'}`,
    };
  }

  if (!preflight.ready) {
    return { recordId: applicant.recordId, outcome: 'SKIPPED_PREFLIGHT_FAILED', reason: preflight.errors[0].reason };
  }

  let automationResult: { outcome: 'SAVED' | 'ERROR' | 'AMBIGUOUS' | 'AWAITING_MANUAL_CONTINUATION'; detail?: string };
  try {
    automationResult = await deps.automation.submitApplicant({
      recordId: applicant.recordId,
      draft: preflight.draft,
      isLastApplicantInBatch,
      maritalStatus: preflight.maritalStatus,
      countryOfBirth: preflight.countryOfBirth,
      cityOfBirth: preflight.cityOfBirth,
      countryOfResidence: preflight.countryOfResidence,
      cityOfResidence: preflight.cityOfResidence,
      profession: preflight.profession,
      expectedDateOfArrival: preflight.expectedDateOfArrival,
      expectedDateOfDeparture: preflight.expectedDateOfDeparture,
    });
  } catch (error) {
    // The automation step itself crashed/threw (timeout, disconnect, an
    // unhandled exception mid-submission) -- exactly the "worker crash
    // before observing an outcome" case. Never guess SAVED, never
    // auto-retry: the record is left SUBMITTING; stale-recovery handles it.
    return {
      recordId: applicant.recordId,
      outcome: 'UNEXPECTED_ERROR',
      detail: `automation threw: ${error instanceof Error ? error.message : 'unknown error'}`,
    };
  }

  const finalize = await finalizeApplicantSubmission(deps.queueStore, applicant.recordId, automationResult.outcome, nowMs);
  if (!finalize.ok) {
    // The transition was rejected (e.g. the record was no longer
    // SUBMITTING by the time we tried to finalize it) -- never pretend
    // the automation's reported outcome was actually recorded.
    return {
      recordId: applicant.recordId,
      outcome: 'UNEXPECTED_ERROR',
      detail: `finalize rejected: ${finalize.reason}`,
    };
  }

  if (automationResult.outcome === 'SAVED') {
    // Package 5.41: no longer silently discards automationResult.detail --
    // see VisaWorkerLoopApplicantOutcome's own doc comment for why. The
    // conditional spread (rather than always including `detail`, even as
    // `undefined`) is deliberate: countless existing tests assert a bare
    // `{recordId, outcome: 'SAVED'}` via assert.deepEqual, which treats an
    // explicit `detail: undefined` property as a DIFFERENT shape -- this
    // never adds a key that was not genuinely present.
    return automationResult.detail
      ? { recordId: applicant.recordId, outcome: 'SAVED', detail: automationResult.detail }
      : { recordId: applicant.recordId, outcome: 'SAVED' };
  }
  return { recordId: applicant.recordId, outcome: automationResult.outcome, detail: automationResult.detail };
}

/**
 * Processes every given applicant for ONE batch, under ONE batch
 * processing lock held for the whole run -- mirroring this codebase's own
 * existing design intent (visaSubmissionQueueStore.ts's VisaBatchLockStore
 * doc comment: "a future real automation step will drive ONE browser
 * session through an entire batch"). If the lock is already held by
 * another worker, this returns immediately WITHOUT touching a single
 * applicant -- never partially proceeds.
 *
 * One applicant's unexpected failure never aborts the rest of the batch
 * (same per-item try/catch convention as recoverStaleSubmittingToAmbiguous
 * and every other per-item sweep in this codebase) -- processOneApplicant
 * itself never throws; every failure mode is captured as an outcome.
 *
 * The lock is ALWAYS released in a finally block, even if something above
 * throws unexpectedly; a release failure is logged but never thrown,
 * so it can never mask whatever applicant outcomes were already produced.
 */
export async function runVisaWorkerLoopForBatch(
  batchId: string,
  workerId: string,
  applicants: readonly VisaWorkerLoopApplicantInput[],
  nowMs: number,
  deps: VisaWorkerLoopDependencies,
): Promise<VisaWorkerLoopResult> {
  const lockResult = await acquireBatchProcessingLock(deps.lockStore, batchId, workerId, nowMs);
  if (lockResult.outcome === 'already-locked') {
    return { lockOutcome: 'already-locked', applicantOutcomes: [] };
  }

  let batchValidation: VisaWorkerLoopBatchValidation = { outcome: 'ok' };
  const applicantOutcomes: VisaWorkerLoopApplicantOutcome[] = [];
  try {
    // Batch completeness/order check (Package 5.0 audit finding #2): the
    // given list is verified against the batch's real active membership
    // and real position_in_batch order BEFORE a single applicant is
    // touched. If this fails, NOT ONE applicant is claimed or submitted --
    // isLastApplicantInBatch would otherwise be meaningless for a
    // partial, duplicated, misordered, or cross-batch-contaminated list.
    const realPositions = await deps.findActiveApplicantPositions(batchId);
    batchValidation = validateApplicantListAgainstBatch(applicants, realPositions);

    if (batchValidation.outcome === 'ok') {
      for (let index = 0; index < applicants.length; index += 1) {
        const isLastApplicantInBatch = index === applicants.length - 1;
        applicantOutcomes.push(await processOneApplicant(applicants[index]!, batchId, isLastApplicantInBatch, deps, nowMs));
      }
    }
  } finally {
    try {
      await releaseBatchProcessingLock(deps.lockStore, batchId, workerId);
    } catch (releaseError) {
      console.error(`[visa-worker-loop] failed to release batch lock for batch ${batchId}`, releaseError);
    }
  }

  return { lockOutcome: 'acquired', batchValidation, applicantOutcomes };
}
