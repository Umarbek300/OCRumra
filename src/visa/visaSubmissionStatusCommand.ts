import { findGroupByTelegramChatId } from '../db/repositories/groups.repo.js';
import { findLastBatchForGroup } from '../db/repositories/visaBatches.repo.js';
import {
  countPendingWithInactiveApplicantForBatch,
  countQueueStatusesForBatch,
  countUnresolvedConflictsForBatch,
  type VisaSubmissionStatus,
} from '../db/repositories/visaSubmissionQueue.repo.js';

export type VisaSubmissionStatusCommandOutcome =
  | { kind: 'UNAUTHORIZED' }
  | { kind: 'GROUP_NOT_FOUND' }
  /** The group has no VisitSaudi batch at all yet -- distinct from a batch existing with an empty/not-yet-queued submission queue. */
  | { kind: 'NO_BATCH' }
  | {
      kind: 'COMPLETED';
      batchName: string;
      counts: Record<VisaSubmissionStatus, number>;
      conflictCount: number;
      /** Package 5.12: how many of counts.PENDING belong to an applicant that is no longer active -- see countPendingWithInactiveApplicantForBatch's own doc comment. Always <= counts.PENDING. */
      inactivePendingCount: number;
    };

export interface VisaSubmissionStatusCommandInput {
  telegramChatId: number;
  /** Same 'creator' | 'administrator' rule as visaAssignCommand.ts's own authorStatus check. */
  authorStatus: string;
}

export interface VisaSubmissionStatusCommandDependencies {
  findGroup: typeof findGroupByTelegramChatId;
  findLastBatch: typeof findLastBatchForGroup;
  countStatuses: typeof countQueueStatusesForBatch;
  countConflicts: typeof countUnresolvedConflictsForBatch;
  countInactivePending: typeof countPendingWithInactiveApplicantForBatch;
}

const defaultDependencies: VisaSubmissionStatusCommandDependencies = {
  findGroup: findGroupByTelegramChatId,
  findLastBatch: findLastBatchForGroup,
  countStatuses: countQueueStatusesForBatch,
  countConflicts: countUnresolvedConflictsForBatch,
  countInactivePending: countPendingWithInactiveApplicantForBatch,
};

/**
 * Read-only operator status view for a group's most recent VisitSaudi
 * batch: how many submission-queue rows sit in each status, plus how many
 * carry an unresolved cancellation conflict (see cancelWithConflictCheck).
 * Deliberately the FIRST, smallest, zero-mutation piece of Package 3 --
 * same Telegram-free "command core" convention as visaAssignCommand.ts
 * (bot.ts would do only the Telegram plumbing; this function makes no
 * Telegram call itself).
 *
 * Never writes anything: every dependency here is a pure read. Safe to
 * call at any time, including concurrently, by any number of operators.
 */
export async function visaSubmissionStatusCommand(
  input: VisaSubmissionStatusCommandInput,
  deps: VisaSubmissionStatusCommandDependencies = defaultDependencies,
): Promise<VisaSubmissionStatusCommandOutcome> {
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

  const [counts, conflictCount, inactivePendingCount] = await Promise.all([
    deps.countStatuses(batch.id),
    deps.countConflicts(batch.id),
    deps.countInactivePending(batch.id),
  ]);

  return { kind: 'COMPLETED', batchName: batch.batchName, counts, conflictCount, inactivePendingCount };
}
