import { findGroupByTelegramChatId } from '../db/repositories/groups.repo.js';
import { cancelWithConflictCheck, findApplicantGroupId } from '../db/repositories/visaSubmissionQueue.repo.js';

export type VisaStopApplicantCommandOutcome =
  | { kind: 'UNAUTHORIZED' }
  | { kind: 'GROUP_NOT_FOUND' }
  /** The applicant id is unknown, OR it belongs to a DIFFERENT group -- deliberately the SAME outcome for both, so this command never discloses whether an applicant id exists in someone else's group. */
  | { kind: 'APPLICANT_NOT_FOUND' }
  /** Already cancelled/removed -- a safe no-op, not an error. */
  | { kind: 'ALREADY_INACTIVE' }
  /** Cleanly stopped -- no submission was ever claimed (PENDING, or no queue row at all yet). */
  | { kind: 'STOPPED' }
  /** Stopped, but the submission queue row was SUBMITTING -- a portal request MAY already be in flight. Never hidden. */
  | { kind: 'STOPPED_BUT_MAY_ALREADY_BE_SUBMITTED' };

export interface VisaStopApplicantCommandInput {
  telegramChatId: number;
  /** Same 'creator' | 'administrator' rule as every other VisitSaudi operator command. */
  authorStatus: string;
  visaBatchApplicantId: string;
}

export interface VisaStopApplicantCommandDependencies {
  findGroup: typeof findGroupByTelegramChatId;
  findApplicantGroupId: typeof findApplicantGroupId;
  cancelWithConflictCheck: typeof cancelWithConflictCheck;
}

const defaultDependencies: VisaStopApplicantCommandDependencies = {
  findGroup: findGroupByTelegramChatId,
  findApplicantGroupId,
  cancelWithConflictCheck,
};

/**
 * The "TO'XTATISH" (STOP) operator action. Reuses cancelWithConflictCheck
 * (Package 1) entirely -- no new state machine, no new transaction, no
 * new lock. This function's only addition is the cross-group ownership
 * check (an operator may only act on an applicant in THEIR OWN group) and
 * mapping cancelWithConflictCheck's own result onto an operator-facing
 * outcome that NEVER hides a detected conflict.
 *
 * If the applicant's submission was already SUBMITTING, the cancellation
 * still proceeds (same as cancelWithConflictCheck's own, already-audited
 * behavior) and the conflict is already durably recorded (conflict_detected_at
 * + a 'conflict' operator alert, both written inside that SAME
 * transaction) -- this function only surfaces that fact distinctly
 * (STOPPED_BUT_MAY_ALREADY_BE_SUBMITTED) rather than reporting a plain
 * STOPPED, which would wrongly imply nothing was ever sent.
 *
 * Idempotent: calling this twice for the same applicant is always safe --
 * the second call finds the applicant already inactive
 * (cancelWithConflictCheck's own cancelled:false) and reports
 * ALREADY_INACTIVE, never re-cancelling or re-raising a conflict.
 */
export async function visaStopApplicantCommand(
  input: VisaStopApplicantCommandInput,
  deps: VisaStopApplicantCommandDependencies = defaultDependencies,
): Promise<VisaStopApplicantCommandOutcome> {
  if (input.authorStatus !== 'creator' && input.authorStatus !== 'administrator') {
    return { kind: 'UNAUTHORIZED' };
  }

  const group = await deps.findGroup(input.telegramChatId);
  if (!group) {
    return { kind: 'GROUP_NOT_FOUND' };
  }

  const applicantGroupId = await deps.findApplicantGroupId(input.visaBatchApplicantId);
  if (!applicantGroupId || applicantGroupId !== group.id) {
    return { kind: 'APPLICANT_NOT_FOUND' };
  }

  const result = await deps.cancelWithConflictCheck(input.visaBatchApplicantId, 'cancelled');
  if (!result.cancelled) {
    return { kind: 'ALREADY_INACTIVE' };
  }
  if (result.conflictDetected) {
    return { kind: 'STOPPED_BUT_MAY_ALREADY_BE_SUBMITTED' };
  }
  return { kind: 'STOPPED' };
}
