import { findGroupByTelegramChatId } from '../db/repositories/groups.repo.js';
import { countActiveApplicantsInBatch, findLastBatchForGroup } from '../db/repositories/visaBatches.repo.js';
import { createQueueForBatch, createSubmissionAttempt } from '../db/repositories/visaSubmissionQueue.repo.js';

export type VisaQueueBatchCommandOutcome =
  | { kind: 'UNAUTHORIZED' }
  | { kind: 'GROUP_NOT_FOUND' }
  /** The group has no VisitSaudi batch at all yet. */
  | { kind: 'NO_BATCH' }
  /** A batch exists but every applicant in it is currently cancelled/removed -- nothing to queue. */
  | { kind: 'EMPTY_BATCH'; batchName: string }
  /** createQueueForBatch already has rows for this batch (any status, including SUBMITTING/SAVED/AMBIGUOUS) -- a safe no-op, never a failure. */
  | { kind: 'ALREADY_QUEUED'; batchName: string }
  | { kind: 'QUEUED'; batchName: string; queuedCount: number };

export interface VisaQueueBatchCommandInput {
  telegramChatId: number;
  /** Same 'creator' | 'administrator' rule as visaAssignCommand.ts's own authorStatus check. */
  authorStatus: string;
  /** The operator's own identity, recorded on visa_submission_attempts.requested_by -- see bot.ts's existing `telegram:${username ?? id}` convention. */
  requestedBy: string;
}

export interface VisaQueueBatchCommandDependencies {
  findGroup: typeof findGroupByTelegramChatId;
  findLastBatch: typeof findLastBatchForGroup;
  countActiveApplicants: typeof countActiveApplicantsInBatch;
  createAttempt: typeof createSubmissionAttempt;
  createQueue: typeof createQueueForBatch;
}

const defaultDependencies: VisaQueueBatchCommandDependencies = {
  findGroup: findGroupByTelegramChatId,
  findLastBatch: findLastBatchForGroup,
  countActiveApplicants: countActiveApplicantsInBatch,
  createAttempt: createSubmissionAttempt,
  createQueue: createQueueForBatch,
};

/**
 * Operator command: queues the group's current (most recent) VisitSaudi
 * batch for submission -- creates the durable visa_submission_attempts +
 * visa_submission_queue rows (Package 1), nothing more. This is
 * DELIBERATELY NOT a portal submission: no network call to
 * visa.visitsaudi.com is made here or anywhere this function's own
 * dependencies reach, and no visa_submission_queue row this creates is
 * ever anything other than PENDING -- claiming/submitting is a SEPARATE,
 * not-yet-built step (Phase 2e).
 *
 * Batch selection: always the group's most recent visa_batches row for
 * the 'visitsaudi' portal (findLastBatchForGroup) -- the SAME selection
 * visaSubmissionStatusCommand.ts already uses. This command never reads
 * the Google Sheet directly; "Sheet row order" is already reflected
 * transitively, because assignVisaBatch.ts (via /visa_assign) is what
 * originally assigned each applicant's position_in_batch/batch_number in
 * Sheet-processing order -- this command only ever operates on rows
 * already written to visa_batch_applicants, never the Sheet itself.
 *
 * The 10-applicants-per-batch cap is NOT re-implemented here: it is
 * already, structurally, impossible to violate, because assignVisaBatch.ts
 * itself never lets an 11th active applicant join a batch
 * (idx_visa_batch_applicants_position_active + its own MAX_BATCH_SIZE
 * check) -- queuing only ever touches applicants already in the batch.
 *
 * Idempotency / double-click safety: createSubmissionAttempt's own
 * ON CONFLICT(batch_id) and createQueueForBatch's own attempt-row FOR
 * UPDATE lock (see that function's doc comment) together make two
 * concurrent calls for the SAME batch converge safely -- exactly one
 * creates the attempt and the queue rows, the other(s) observe
 * ALREADY_QUEUED, never a duplicate attempt or a duplicate queue row, and
 * never an unhandled database error.
 *
 * Never touches visa_batch_processing_locks: that lock exists for a
 * DIFFERENT, later concern (one browser session driving actual portal
 * automation through an entire batch, Phase 2e) -- queuing has its own,
 * already-sufficient atomicity (createQueueForBatch's own transaction +
 * the UNIQUE constraint on visa_batch_applicant_id) and does not need it.
 */
export async function visaQueueBatchCommand(
  input: VisaQueueBatchCommandInput,
  deps: VisaQueueBatchCommandDependencies = defaultDependencies,
): Promise<VisaQueueBatchCommandOutcome> {
  if (input.authorStatus !== 'creator' && input.authorStatus !== 'administrator') {
    return { kind: 'UNAUTHORIZED' };
  }

  const group = await deps.findGroup(input.telegramChatId);
  if (!group) {
    return { kind: 'GROUP_NOT_FOUND' };
  }

  const batch = await deps.findLastBatch(group.id, 'visitsaudi');
  if (!batch) {
    return { kind: 'NO_BATCH' };
  }

  const activeCount = await deps.countActiveApplicants(batch.id);
  if (activeCount === 0) {
    return { kind: 'EMPTY_BATCH', batchName: batch.batchName };
  }

  const attempt = await deps.createAttempt(batch.id, input.requestedBy);
  const created = await deps.createQueue(batch.id, attempt.id);
  if (created === null) {
    return { kind: 'ALREADY_QUEUED', batchName: batch.batchName };
  }

  return { kind: 'QUEUED', batchName: batch.batchName, queuedCount: created.length };
}
