import type { Page } from 'playwright';
import type { VisaBatch } from './types.js';
import { createVisitSaudiGroup } from './visitSaudiPageActions.js';
import {
  runVisaWorkerLoopForBatch,
  type VisaWorkerLoopApplicantInput,
  type VisaWorkerLoopDependencies,
  type VisaWorkerLoopResult,
} from './visaWorkerLoop.js';
import { buildVisaBatchSubmissionOperatorSummary } from './visaSubmissionResultMessage.js';

/**
 * ============================================================================
 * Package 5.33 -- wires createVisitSaudiGroup into the real submission path,
 * for the ONE integration point Package 5.29 found genuinely missing:
 * nothing in this codebase ever called it.
 * ============================================================================
 *
 * This is a ONE-TIME, OPERATOR-INVOKED batch start, deliberately kept
 * SEPARATE from runVisaWorkerLoopForBatch (reused below, completely
 * UNCHANGED) rather than merged into it:
 *
 *  - Package 5.29 found no safe way to make group creation idempotent
 *    INSIDE the automatic, per-applicant, retry-driven worker loop (no
 *    existing persistent "group already created for this batch" flag
 *    exists without a migration -- visa_batches.status has zero callers
 *    and would be an unverified, guessed repurposing). Merging
 *    createVisitSaudiGroup into runVisaWorkerLoopForBatch would risk
 *    creating a duplicate portal group on every retry pass.
 *  - Calling THIS function is the caller's own, one-time decision -- the
 *    same category of operator responsibility as the already-approved
 *    "the user performs portal login manually" rule. A caller starts a
 *    NEW batch by calling this once; any LATER retry for the same batch
 *    (e.g. after a crash, via the stale-recovery path or an operator
 *    re-run) calls runVisaWorkerLoopForBatch directly -- never this
 *    function again, since the group already exists by then.
 *
 * Everything after group creation (claim, preflight, per-applicant
 * portrait upload + SAVE/SAVE AND MOVE TO THE NEXT APPLICANT sequencing,
 * batch-lock management, crash/ambiguous-outcome safety) is exactly
 * runVisaWorkerLoopForBatch's own, already-tested behavior -- not
 * duplicated here. If group creation itself throws (e.g. the portal
 * rejects the name, or a future selector mismatch), it propagates
 * uncaught and runVisaWorkerLoopForBatch is never even reached -- no
 * batch lock is acquired and no applicant is claimed, so there is
 * nothing to roll back.
 *
 * Package 5.42: the returned result also carries `operatorSummaryText` --
 * a ready, already-tested, Telegram-ready operator summary (see
 * visaSubmissionResultMessage.ts's own doc comment for the full
 * reasoning), built from this SAME run's own applicantOutcomes, so that
 * whichever caller eventually invokes this function (Phase 2e's own bot
 * command, not yet built -- see that file's own doc comment for why
 * building it now is out of scope) can show an operator exactly which
 * applicants carry a caveat (a hotel-autocomplete suggestion that was
 * never found/selected, or Page 5/Insurance never reached) with a single
 * `ctx.reply(result.operatorSummaryText)`, never having to re-derive this
 * formatting itself. This is purely additive: runVisaWorkerLoopForBatch's
 * own return type/contract is completely unchanged.
 */
export interface StartVisitSaudiBatchSubmissionResult extends VisaWorkerLoopResult {
  operatorSummaryText: string;
}

export async function startVisitSaudiBatchSubmission(
  page: Page,
  batch: Pick<VisaBatch, 'id' | 'batchName'>,
  workerId: string,
  applicants: readonly VisaWorkerLoopApplicantInput[],
  nowMs: number,
  deps: VisaWorkerLoopDependencies,
): Promise<StartVisitSaudiBatchSubmissionResult> {
  await createVisitSaudiGroup(page, batch.batchName);
  const result = await runVisaWorkerLoopForBatch(batch.id, workerId, applicants, nowMs, deps);
  return { ...result, operatorSummaryText: buildVisaBatchSubmissionOperatorSummary(batch.batchName, result) };
}
