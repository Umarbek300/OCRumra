import type { VisitSaudiApplicationDraft } from './types.js';
import type { MaritalStatusForVisitSaudi } from './computeMaritalStatusForVisitSaudi.js';
import type { ProfessionForVisitSaudi } from './genderProfessionMap.js';

/**
 * A SEPARATE, NEW contract from visitSaudiAutomation.ts's own
 * VisitSaudiAutomationContract -- deliberately not reused, because that
 * existing contract's fillGroupApplication() returns a BATCH-level
 * outcome (AWAITING_CAPTCHA | AWAITING_FINAL_REVIEW | AWAITING_PAYMENT --
 * "which human checkpoint comes next"), never a PER-APPLICANT save result.
 * Nothing in this codebase today models "did pressing SAVE /
 * SAVE AND MOVE TO THE NEXT APPLICANT for THIS ONE applicant succeed,
 * fail, or come back unclear" -- that is exactly, and only, what this
 * file adds, scoped to the worker-loop's own finalize decision
 * (visaWorkerLoop.ts). A future real implementation of this interface is
 * Phase 2e/2f's job (see Package 4.4's own planning report) -- out of
 * scope here.
 */
export type VisaApplicantAutomationOutcome = 'SAVED' | 'ERROR' | 'AMBIGUOUS';

export interface VisaApplicantAutomationResult {
  outcome: VisaApplicantAutomationOutcome;
  /** Free-form diagnostic detail -- never PII beyond what the draft itself already carries, same convention as visa_submission_queue.last_error. */
  detail?: string;
}

/**
 * Attempts to submit (SAVE) ONE already-claimed applicant's draft on the
 * real portal. CAPTCHA, OTP, and payment are, by the same design rule as
 * VisitSaudiAutomationContract's own doc comment, NEVER automated steps a
 * real implementation of this interface may take on its own -- any real
 * implementation must report AMBIGUOUS (or throw, which the caller treats
 * identically -- see visaWorkerLoop.ts) rather than guess past one of
 * those checkpoints. PAY FOR GROUP / AGREE & COMPLETE PAYMENT are not
 * reachable from this interface at all -- it models only the per-applicant
 * SAVE step, never a batch-level payment/finalization action.
 *
 * isLastApplicantInBatch tells a real implementation WHICH portal button
 * to press for this applicant -- the real VisitSaudi "Apply for Group"
 * form exposes two distinct actions (see this engagement's own Phase 2
 * business rules): every applicant except the batch's last one must use
 * SAVE AND MOVE TO THE NEXT APPLICANT (stays on the same multi-applicant
 * form, advances to the next slot); the batch's LAST applicant must use
 * plain SAVE (the one action that can trigger the group-level review/
 * payment screen). This flag is computed once, by the caller
 * (visaWorkerLoop.ts, from the given applicants list's own order), never
 * guessed by the adapter itself from, e.g., re-querying batch size.
 */
export interface VisaApplicantAutomationAdapter {
  submitApplicant(input: {
    recordId: string;
    draft: VisitSaudiApplicationDraft;
    isLastApplicantInBatch: boolean;
    /**
     * Package 5.36: added so a real adapter can fill Page 3's personal-info
     * fields (visitSaudiPageActions.ts's fillApplicantPersonalInfoFields) --
     * every one of these is ALREADY computed by visitSaudiPreflight.ts's
     * VisitSaudiReadyApplicant; the caller (visaWorkerLoop.ts) passes that
     * same preflight result's own fields through unchanged, nothing
     * re-derived here.
     */
    maritalStatus: MaritalStatusForVisitSaudi;
    countryOfBirth: string;
    cityOfBirth: string;
    countryOfResidence: string;
    cityOfResidence: string;
    profession: ProfessionForVisitSaudi;
    /**
     * Package 5.38: added so a real adapter can also attempt Page 4's
     * `Expected Date of Arrival*`/`Expected Date of Departure*` fields
     * (visitSaudiPageActions.ts's fillApplicantTripDetailsFields) --
     * already computed by visitSaudiPreflight.ts's VisitSaudiReadyApplicant;
     * the caller (visaWorkerLoop.ts) passes that same preflight result's
     * own fields through unchanged, nothing re-derived here.
     */
    expectedDateOfArrival: string;
    expectedDateOfDeparture: string;
  }): Promise<VisaApplicantAutomationResult>;
}
