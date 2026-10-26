import { findGroupByTelegramChatId } from '../db/repositories/groups.repo.js';
import { findApplicantGroupId, findQueueRecordByApplicantId, flagAmbiguousForReview } from '../db/repositories/visaSubmissionQueue.repo.js';

export type VisaCheckAmbiguousCommandOutcome =
  | { kind: 'UNAUTHORIZED' }
  | { kind: 'GROUP_NOT_FOUND' }
  /** Same never-leaking outcome as visaStopApplicantCommand.ts: unknown id or a different group's applicant. */
  | { kind: 'APPLICANT_NOT_FOUND' }
  /** The applicant has no submission_queue row at all -- it was never queued, so there is nothing ambiguous to check. */
  | { kind: 'NO_QUEUE_RECORD' }
  /** A queue row exists but its CURRENT status is not AMBIGUOUS -- this command only ever applies to AMBIGUOUS, never any other status. */
  | { kind: 'NOT_AMBIGUOUS' }
  | { kind: 'FLAGGED_FOR_REVIEW' }
  /** Idempotent repeat -- already flagged by an earlier call, nothing new written. */
  | { kind: 'ALREADY_FLAGGED' };

export interface VisaCheckAmbiguousCommandInput {
  telegramChatId: number;
  authorStatus: string;
  visaBatchApplicantId: string;
}

export interface VisaCheckAmbiguousCommandDependencies {
  findGroup: typeof findGroupByTelegramChatId;
  findApplicantGroupId: typeof findApplicantGroupId;
  findQueueRecordByApplicantId: typeof findQueueRecordByApplicantId;
  flagAmbiguousForReview: typeof flagAmbiguousForReview;
}

const defaultDependencies: VisaCheckAmbiguousCommandDependencies = {
  findGroup: findGroupByTelegramChatId,
  findApplicantGroupId,
  findQueueRecordByApplicantId,
  flagAmbiguousForReview,
};

/**
 * The "PORTALDA TEKSHIRISH" operator action. Makes explicit, durable, and
 * idempotent what the AMBIGUOUS status already means on its own
 * (visaSubmissionStatus.ts's own doc comment: "never resubmit until an
 * operator checks the portal directly") -- this function records that an
 * operator has now been asked to do exactly that, via
 * flagAmbiguousForReview (visa_submission_reviews + a durable
 * 'ambiguous_submission' operator alert).
 *
 * NEVER changes visa_submission_queue.status -- an AMBIGUOUS row stays
 * AMBIGUOUS after this call, exactly as before it. This function cannot
 * be used, directly or indirectly, to resubmit or reset anything; it only
 * ever reads the current status and (for a genuinely AMBIGUOUS row)
 * writes an annotation that a human has been asked to look.
 */
export async function visaCheckAmbiguousCommand(
  input: VisaCheckAmbiguousCommandInput,
  deps: VisaCheckAmbiguousCommandDependencies = defaultDependencies,
): Promise<VisaCheckAmbiguousCommandOutcome> {
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

  const queueRecord = await deps.findQueueRecordByApplicantId(input.visaBatchApplicantId);
  if (!queueRecord) {
    return { kind: 'NO_QUEUE_RECORD' };
  }

  const outcome = await deps.flagAmbiguousForReview(
    queueRecord.id,
    `operator requested a portal check for visa_batch_applicant ${input.visaBatchApplicantId}`,
  );

  if (outcome === 'not-ambiguous') {
    return { kind: 'NOT_AMBIGUOUS' };
  }
  return outcome === 'flagged' ? { kind: 'FLAGGED_FOR_REVIEW' } : { kind: 'ALREADY_FLAGGED' };
}
