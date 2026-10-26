import { findGroupByTelegramChatId } from '../db/repositories/groups.repo.js';
import { findLastBatchForGroup } from '../db/repositories/visaBatches.repo.js';
import { findAttentionNeededForBatch, type AttentionNeededRecord } from '../db/repositories/visaSubmissionQueue.repo.js';

export type VisaAttentionQueueCommandOutcome =
  | { kind: 'UNAUTHORIZED' }
  | { kind: 'GROUP_NOT_FOUND' }
  | { kind: 'NO_BATCH' }
  /** items may be an empty array -- "nothing currently needs attention", not an error. */
  | { kind: 'COMPLETED'; groupName: string; batchName: string; items: readonly AttentionNeededRecord[] };

export interface VisaAttentionQueueCommandInput {
  telegramChatId: number;
  authorStatus: string;
}

export interface VisaAttentionQueueCommandDependencies {
  findGroup: typeof findGroupByTelegramChatId;
  findLastBatch: typeof findLastBatchForGroup;
  findAttentionNeeded: typeof findAttentionNeededForBatch;
}

const defaultDependencies: VisaAttentionQueueCommandDependencies = {
  findGroup: findGroupByTelegramChatId,
  findLastBatch: findLastBatchForGroup,
  findAttentionNeeded: findAttentionNeededForBatch,
};

/**
 * Read-only: lists the group's current VisitSaudi batch items that need
 * an operator's decision (a detected cancellation conflict on a
 * SUBMITTING row, or an AMBIGUOUS outcome) -- see
 * findAttentionNeededForBatch's own doc comment for exactly which rows
 * qualify. bot.ts uses this list to attach DAVOM ETISH / TO'XTATISH /
 * PORTALDA TEKSHIRISH buttons to one message per item; this function
 * itself never writes anything and never contacts the portal.
 */
export async function visaAttentionQueueCommand(
  input: VisaAttentionQueueCommandInput,
  deps: VisaAttentionQueueCommandDependencies = defaultDependencies,
): Promise<VisaAttentionQueueCommandOutcome> {
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

  const items = await deps.findAttentionNeeded(batch.id);
  return { kind: 'COMPLETED', groupName: group.name, batchName: batch.batchName, items };
}
