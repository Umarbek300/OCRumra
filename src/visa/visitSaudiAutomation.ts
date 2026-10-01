import type { VisaApplicationDraft, VisaBatch } from './types.js';

export type VisitSaudiFillOutcome = 'AWAITING_CAPTCHA' | 'AWAITING_FINAL_REVIEW' | 'AWAITING_PAYMENT';

/**
 * CONTRACT ONLY -- Phase 1 deliberately stops here. No Playwright, no
 * browser launch, no network call to visa.visitsaudi.com is implemented
 * against this interface yet (see the implementation-ready specification
 * this module was planned against). Phase 2 fills this in.
 *
 * CAPTCHA and payment are, by design, NEVER automated steps of this
 * contract -- any real implementation must stop and hand control back to
 * the operator at both points, never attempt to solve or bypass either.
 */
export interface VisitSaudiAutomationContract {
  /**
   * Intended future behavior: fills the "Apply for Group" form for every
   * draft in the batch (at most 10 -- see assignVisaBatch.ts), then stops
   * and reports which human checkpoint the operator must now complete by
   * hand in the real browser session.
   */
  fillGroupApplication(
    batch: Pick<VisaBatch, 'id' | 'batchName'>,
    drafts: readonly Extract<VisaApplicationDraft, { portal: 'visitsaudi' }>[],
  ): Promise<{ outcome: VisitSaudiFillOutcome }>;
}
