import type { VisaWorkerLoopApplicantOutcome, VisaWorkerLoopResult } from './visaWorkerLoop.js';

/**
 * ============================================================================
 * Package 5.42 -- pure (Telegram-call-free) operator-facing text builder
 * for the result of ONE batch's submission run (runVisaWorkerLoopForBatch
 * / startVisitSaudiBatchSubmission) -- same "pure core, Telegram plumbing
 * stays in bot.ts" convention already established by visaAttentionMessage.ts
 * (see that file's own doc comment: extracted out specifically so it can
 * be unit-tested directly, without mocking grammy's Context).
 * ============================================================================
 *
 * WHY this exists: Package 5.41 closed the gap where VisaWorkerLoopApplicantOutcome's
 * SAVED variant carries its own `detail` (the real adapter's own
 * diagnostic note -- e.g. "hotel autocomplete suggestion was not found/
 * selected" or "Page 5 (Insurance) did not appear -- insurance consent
 * NOT confirmed") instead of silently discarding it. But NOTHING in this
 * codebase reads that detail yet: a direct grep (this package's own
 * audit) confirms NO bot command, cron job, or any other caller anywhere
 * invokes startVisitSaudiBatchSubmission or runVisaWorkerLoopForBatch in
 * production today -- only their own definitions and tests reference
 * them. Every existing VisitSaudi bot command (/visa_assign,
 * /visa_submission_status, /visa_queue_batch, /visa_stop_applicant,
 * /visa_check_ambiguous, /visa_attention_queue) either assigns/queues
 * applicants or reacts to an ALREADY-RECORDED conflict/AMBIGUOUS outcome
 * -- none of them ever triggers the actual portal-automation step
 * (Phase 2e, this engagement's own long-standing "out of scope here"
 * marker). Building that live trigger would mean opening a real
 * Playwright session against the real VisitSaudi portal from a bot
 * command -- explicitly outside this package's safe scope (no real
 * portal access, no new large architecture).
 *
 * What IS safely in scope, and done here: a ready, directly tested
 * formatter, built from the SAME already-existing VisaWorkerLoopResult/
 * VisaWorkerLoopApplicantOutcome types (nothing new invented), so that
 * the MOMENT Phase 2e's own bot command is eventually built, showing an
 * operator each applicant's SAVED-with-caveat status is a single function
 * call away (`ctx.reply(buildVisaBatchSubmissionOperatorSummary(...))`),
 * not a new design question. startVisitSaudiBatchSubmission.ts's own
 * result now carries this text directly (see that file's own doc
 * comment) -- this module itself never sends anything anywhere.
 */

/**
 * Package 5.41/5.42: a SAVED outcome's own `detail`, when present, is
 * PURELY an informational caveat -- it NEVER changes this line's own
 * "SAVED" wording (a hotel-suggestion-not-found or Page-5-not-reached
 * caveat is never treated as, or displayed as, a failure). When `detail`
 * is ABSENT, this line is left EXACTLY as plain as every earlier
 * package's own implicit behavior -- no extra marker, no extra sentence
 * -- per this package's own requirement not to change the existing
 * no-detail case.
 */
function formatOneApplicantLine(positionInBatch: number, outcome: VisaWorkerLoopApplicantOutcome): string {
  const base = `${positionInBatch}-o'rin: ${outcome.outcome}`;
  if (outcome.outcome === 'SAVED') {
    return outcome.detail ? `${base}\n   ⚠️ ${outcome.detail}` : base;
  }
  if ('detail' in outcome && outcome.detail) {
    return `${base}\n   ${outcome.detail}`;
  }
  if ('reason' in outcome && outcome.reason) {
    return `${base}\n   ${outcome.reason}`;
  }
  return base;
}

/**
 * Builds the full operator-facing summary for ONE batch submission run.
 * "N-o'rin" (position) is the applicant outcome's own 1-based array
 * index within `result.applicantOutcomes` -- the SAME already-proven
 * order-preservation guarantee runVisaWorkerLoopForBatch's own tests
 * verify (processOneApplicant is called once per given applicant, in
 * order, via a plain indexed for-loop; see
 * visa.visitSaudiBrowserAutomationAdapter.test.ts's own 10-applicant,
 * no-cross-contamination test). Never a guessed or invented personal
 * name -- same convention visaAttentionMessage.ts's own
 * `item.positionInBatch` already uses.
 */
export function buildVisaBatchSubmissionOperatorSummary(batchName: string, result: VisaWorkerLoopResult): string {
  if (result.lockOutcome === 'already-locked') {
    return `VisitSaudi topshirish -- Batch: ${batchName}\nBoshqa worker allaqachon ishlamoqda -- hech narsa qayta ishlanmadi.`;
  }
  if (result.batchValidation && result.batchValidation.outcome === 'rejected') {
    return `VisitSaudi topshirish -- Batch: ${batchName}\nRo'yxat tekshiruvidan o'tmadi -- hech bir arizachi qayta ishlanmadi: ${result.batchValidation.reason}`;
  }
  if (result.applicantOutcomes.length === 0) {
    return `VisitSaudi topshirish -- Batch: ${batchName}\nQayta ishlanadigan arizachi topilmadi.`;
  }

  const lines = result.applicantOutcomes.map((outcome, index) => formatOneApplicantLine(index + 1, outcome));
  return [`VisitSaudi topshirish natijasi -- Batch: ${batchName}`, ...lines].join('\n');
}
