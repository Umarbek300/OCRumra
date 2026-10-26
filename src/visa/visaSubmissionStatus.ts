/**
 * Per-applicant VisitSaudi submission status model. Entirely pure --
 * no I/O, no Sheets/DB/Telegram dependency of any kind.
 *
 * Deliberately a DIFFERENT, finer-grained concept from the existing
 * `visa_batch_applicant_status` DB enum ('active' | 'cancelled' | 'removed'
 * -- see migrations/0024_create_visa_batch_tables.sql), which tracks
 * whether an applicant is still assigned to a batch at all, and from
 * `visa_batch_status` ('pending' | 'submitted' | 'completed' | 'failed'),
 * which tracks a whole BATCH, not one applicant. Neither existing enum is
 * modified, extended, or reused here -- this is a new, additive concept,
 * not wired into the DB in this phase (no migration, no new column).
 */

export const VISA_SUBMISSION_STATUSES = ['PENDING', 'SUBMITTING', 'SAVED', 'ERROR', 'AMBIGUOUS'] as const;
export type VisaSubmissionStatus = (typeof VISA_SUBMISSION_STATUSES)[number];

export function isVisaSubmissionStatus(value: string): value is VisaSubmissionStatus {
  return (VISA_SUBMISSION_STATUSES as readonly string[]).includes(value);
}

/**
 * The full, explicit allowed-transition table. A destination NOT listed
 * for a given source is FORBIDDEN -- never inferred from the two statuses'
 * apparent relationship, never allowed "just this once" by a caller.
 *
 * SAVED, ERROR, and AMBIGUOUS are all terminal in THIS phase:
 *  - SAVED: the portal confirmed the save. Never re-submitted (see this
 *    module's own business rule -- a 2nd submission for an already-saved
 *    applicant would risk a duplicate application).
 *  - ERROR: a definite, identified failure. Retry policy is explicitly
 *    OUT OF SCOPE for this phase (per the task's own instruction) -- so no
 *    automatic path out of ERROR exists yet. A future phase may add one
 *    (e.g. ERROR -> PENDING after an operator's explicit retry command),
 *    but that is a deliberate, not-yet-made decision, not an oversight.
 *  - AMBIGUOUS: whether the portal actually saved this applicant is
 *    UNKNOWN (e.g. the worker crashed between the portal's own save and
 *    this system recording the outcome). The business rule is explicit:
 *    never resubmit until an operator checks the portal directly. Who/how
 *    that operator-driven resolution eventually happens (Telegram's
 *    "PORTALDA TEKSHIRISH" flow) is Phase 2c's job, not this one's --
 *    modeling that resolution path here would be reaching ahead of this
 *    phase's own scope, so AMBIGUOUS has NO outgoing transition in this
 *    table yet.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<VisaSubmissionStatus, readonly VisaSubmissionStatus[]>> = {
  PENDING: ['SUBMITTING'],
  SUBMITTING: ['SAVED', 'ERROR', 'AMBIGUOUS'],
  SAVED: [],
  ERROR: [],
  AMBIGUOUS: [],
};

export type CanTransitionResult =
  | { ok: true }
  | { ok: false; reason: 'INVALID_CURRENT_STATUS' | 'INVALID_NEXT_STATUS' | 'FORBIDDEN_TRANSITION' };

/**
 * The single source of truth for "is this transition allowed" -- every
 * other module in this phase (the queue store's atomicTransition contract,
 * the orchestrator) must route every status change through this check
 * before touching any store, never hand-rolling its own notion of which
 * transitions are legal.
 */
export function canTransition(from: string, to: string): CanTransitionResult {
  if (!isVisaSubmissionStatus(from)) {
    return { ok: false, reason: 'INVALID_CURRENT_STATUS' };
  }
  if (!isVisaSubmissionStatus(to)) {
    return { ok: false, reason: 'INVALID_NEXT_STATUS' };
  }
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    return { ok: false, reason: 'FORBIDDEN_TRANSITION' };
  }
  return { ok: true };
}

/**
 * Maps a submission status onto the coarser three-value vocabulary 2a's
 * Sheet status column already uses (visitSaudiStatusCell.ts's own
 * VISA_STATUS_VALUES = PENDING|SAVED|ERROR -- that file is never imported
 * here, to keep this phase independently testable and to avoid touching
 * any 2a-phase file). PENDING and SUBMITTING both map to the Sheet's own
 * 'PENDING' (from an operator's point of view, "not yet confirmed saved"
 * looks the same whether or not a worker currently happens to be mid-
 * submission). AMBIGUOUS deliberately has NO safe mapping: showing it as
 * PENDING would hide that something went wrong; showing it as ERROR would
 * claim more certainty than is actually known; showing it as SAVED could
 * not be more wrong. Which value (if any) 2c should actually show for
 * AMBIGUOUS is an OPEN QUESTION for the operator to decide (see this
 * module's own report) -- never silently guessed here.
 */
export type SheetSubmissionStatusValue = 'PENDING' | 'SAVED' | 'ERROR';

export function mapSubmissionStatusToSheetValue(status: VisaSubmissionStatus): SheetSubmissionStatusValue | 'NO_SAFE_SHEET_MAPPING' {
  switch (status) {
    case 'PENDING':
    case 'SUBMITTING':
      return 'PENDING';
    case 'SAVED':
      return 'SAVED';
    case 'ERROR':
      return 'ERROR';
    case 'AMBIGUOUS':
      return 'NO_SAFE_SHEET_MAPPING';
  }
}
