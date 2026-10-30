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

export const VISA_SUBMISSION_STATUSES = ['PENDING', 'SUBMITTING', 'SAVED', 'ERROR', 'AMBIGUOUS', 'AWAITING_MANUAL_CONTINUATION'] as const;
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
 *    table yet. AMBIGUOUS is deliberately never used for an ordinary,
 *    expected operator pause either (see AWAITING_MANUAL_CONTINUATION
 *    below) -- it means "outcome unknown," never "waiting on a known,
 *    expected next step."
 *  - AWAITING_MANUAL_CONTINUATION: the automation genuinely, successfully
 *    filled this applicant's own Page 3 (Personal Information) and Page 4
 *    (Passport/Traveler) and reached Page 5 (Medical Insurance) -- a KNOWN,
 *    EXPECTED checkpoint (never a crash, timeout, or unexpected state).
 *    From here, a human must complete Page 5/6/7 (insurance consent, Terms
 *    and Conditions, Review Application -- none of these are ever
 *    automated) and then either continue to the next applicant or finish
 *    the batch. SUBMITTING -> AWAITING_MANUAL_CONTINUATION is therefore a
 *    SEPARATE outcome from SAVED/ERROR/AMBIGUOUS, not a replacement for any
 *    of them -- which of the four applies is still decided entirely by
 *    what the automation itself actually observed, never guessed.
 *    AWAITING_MANUAL_CONTINUATION has exactly two outgoing transitions:
 *    -> SUBMITTING (an operator-triggered re-claim to automate the NEXT
 *    applicant's own Page 3/4, once this applicant's manual Page 5/6/7
 *    steps are done) and -> AMBIGUOUS (only via a future stale-timeout
 *    sweep -- not implemented in this phase -- for when an operator never
 *    responds; see this status's own future design report). It deliberately
 *    has NO transition to PENDING: re-deriving "this applicant needs
 *    automation again" by resetting to PENDING would make it
 *    indistinguishable from an applicant that was never attempted at all,
 *    and -- critically -- would make visaStartSubmissionCommand.ts's own
 *    batchAlreadyStarted check (which treats an all-PENDING batch as
 *    "never started") wrongly conclude a batch with an
 *    AWAITING_MANUAL_CONTINUATION applicant had never been touched,
 *    risking a duplicate createVisitSaudiGroup/group-creation attempt --
 *    see that file's own updated check, which now also counts
 *    AWAITING_MANUAL_CONTINUATION as "already started."
 */
const ALLOWED_TRANSITIONS: Readonly<Record<VisaSubmissionStatus, readonly VisaSubmissionStatus[]>> = {
  PENDING: ['SUBMITTING'],
  SUBMITTING: ['SAVED', 'ERROR', 'AMBIGUOUS', 'AWAITING_MANUAL_CONTINUATION'],
  AWAITING_MANUAL_CONTINUATION: ['SUBMITTING', 'AMBIGUOUS'],
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
 *
 * AWAITING_MANUAL_CONTINUATION gets the SAME 'NO_SAFE_SHEET_MAPPING'
 * treatment as AMBIGUOUS, for an analogous reason: showing it as the
 * Sheet's own PENDING would hide that the automation already did real,
 * meaningful work (Page 3/4 filled) and is now waiting on a human, not
 * simply "not started yet" -- and none of PENDING/SAVED/ERROR is an
 * honest description of "waiting on an operator to finish Page 5/6/7."
 * Which value (if any) should actually be shown for this status on the
 * Sheet is left as the SAME kind of open, operator-facing question
 * AMBIGUOUS's own doc comment already raises -- never silently guessed.
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
    case 'AWAITING_MANUAL_CONTINUATION':
      return 'NO_SAFE_SHEET_MAPPING';
  }
}
