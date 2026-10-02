import { findGroupByTelegramChatId } from '../db/repositories/groups.repo.js';
import { findActiveCanonicalLinksForGroup } from '../db/repositories/passportMessageLinks.repo.js';
import { findVisaBatchById } from '../db/repositories/visaBatches.repo.js';
import { assignVisaBatch } from './assignVisaBatch.js';
import { readVerifiedApplicantData } from './readVerifiedApplicantData.js';
import { validateVerifiedApplicantData } from './validateVerifiedApplicantData.js';
import type { ValidationFailureReason } from './types.js';

export type VisaAssignApplicantStatus =
  | { status: 'ASSIGNED'; batchName: string; positionInBatch: number }
  | { status: 'NOT_READY'; reason: ValidationFailureReason; missingFields?: readonly string[] }
  /** The identity has an active canonical link in the DB, but no matching row was found in the Sheet (see readVerifiedApplicantData.ts's own not_found-is-not-an-error convention) -- never treated as ready. */
  | { status: 'SHEET_ROW_NOT_FOUND' }
  /** A real error (Sheets API failure, etc.) while reading this ONE applicant's row -- caught here so it cannot abort the rest of the group. */
  | { status: 'SHEET_READ_FAILED'; message: string }
  /** A real error from assignVisaBatch itself (should be rare -- assignVisaBatch already retries its own internal races). */
  | { status: 'ASSIGNMENT_FAILED'; message: string };

export interface VisaAssignApplicantResult {
  passportIdentityId: string;
  telegramMessageId: string;
  result: VisaAssignApplicantStatus;
}

export type VisaAssignCommandOutcome =
  | { kind: 'UNAUTHORIZED' }
  | { kind: 'GROUP_NOT_FOUND' }
  /** No active canonical applicant at all in this group -- distinct from GROUP_NOT_FOUND (the group itself exists, it is simply empty right now). */
  | { kind: 'EMPTY_GROUP' }
  | { kind: 'COMPLETED'; results: VisaAssignApplicantResult[] };

export interface VisaAssignCommandInput {
  telegramChatId: number;
  /**
   * The Telegram chat member status of whoever sent the command (from
   * ctx.getAuthor().status in bot.ts) -- the SAME rule /remove's own bot.ts
   * handler already enforces ('creator' or 'administrator' only), just
   * centralized here instead of duplicated as bot.ts-only plumbing, so it
   * can be unit tested without mocking a grammy Context.
   */
  authorStatus: string;
}

export interface VisaAssignCommandDependencies {
  findGroup: typeof findGroupByTelegramChatId;
  findActiveCanonicalLinksForGroup: typeof findActiveCanonicalLinksForGroup;
  readVerifiedApplicantData: typeof readVerifiedApplicantData;
  validate: typeof validateVerifiedApplicantData;
  assign: typeof assignVisaBatch;
  findBatchById: typeof findVisaBatchById;
}

const defaultDependencies: VisaAssignCommandDependencies = {
  findGroup: findGroupByTelegramChatId,
  findActiveCanonicalLinksForGroup,
  readVerifiedApplicantData,
  validate: validateVerifiedApplicantData,
  assign: assignVisaBatch,
  findBatchById: findVisaBatchById,
};

/**
 * The /visa_assign operator command's core logic (Telegram-free, exactly
 * the removePassportCommand.ts convention: bot.ts does only Telegram
 * plumbing -- resolving ctx.chat.id, calling ctx.getAuthor(), phrasing the
 * reply -- and delegates every actual decision here).
 *
 * For every applicant CURRENTLY in the group (every active canonical link),
 * independently: reads their live Sheet row (NEVER passport_ocr_results --
 * see readVerifiedApplicantData.ts), validates it for VisitSaudi, and only
 * for a ready applicant calls assignVisaBatch. One applicant's failure
 * (Sheet read error, validation failure, or even an assignVisaBatch error)
 * is recorded in that applicant's OWN result and never aborts the rest of
 * the group -- every applicant always gets exactly one result entry.
 *
 * Idempotent and safe to call repeatedly, including concurrently, for the
 * SAME group: this function adds no locking of its own because it needs
 * none -- assignVisaBatch's own DB constraints (idx_visa_batch_applicants_
 * one_active_assignment, idx_visa_batch_applicants_position_active) are
 * what make a second (or concurrent) call safe, exactly as already proven
 * for assignVisaBatch in isolation. An applicant already assigned simply
 * gets the same ASSIGNED result again, never a duplicate assignment.
 */
export async function visaAssignCommand(
  input: VisaAssignCommandInput,
  deps: VisaAssignCommandDependencies = defaultDependencies,
): Promise<VisaAssignCommandOutcome> {
  if (input.authorStatus !== 'creator' && input.authorStatus !== 'administrator') {
    return { kind: 'UNAUTHORIZED' };
  }

  const group = await deps.findGroup(input.telegramChatId);
  if (!group) {
    return { kind: 'GROUP_NOT_FOUND' };
  }

  const links = await deps.findActiveCanonicalLinksForGroup(group.id);
  if (links.length === 0) {
    return { kind: 'EMPTY_GROUP' };
  }

  const results: VisaAssignApplicantResult[] = [];

  for (const link of links) {
    let data: Awaited<ReturnType<typeof deps.readVerifiedApplicantData>>;
    try {
      data = await deps.readVerifiedApplicantData(group.id, link.passportIdentityId);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      results.push({
        passportIdentityId: link.passportIdentityId,
        telegramMessageId: link.telegramMessageId,
        result: { status: 'SHEET_READ_FAILED', message },
      });
      continue;
    }

    if (!data) {
      results.push({
        passportIdentityId: link.passportIdentityId,
        telegramMessageId: link.telegramMessageId,
        result: { status: 'SHEET_ROW_NOT_FOUND' },
      });
      continue;
    }

    const validation = deps.validate(data, 'visitsaudi');
    if (!validation.ready) {
      results.push({
        passportIdentityId: link.passportIdentityId,
        telegramMessageId: link.telegramMessageId,
        // Mirrors validateVerifiedApplicantData.ts's own convention exactly:
        // missingFields is only ever a present key when it's an actual
        // array (MISSING_FIELDS), never an explicit `missingFields: undefined`
        // for every other reason -- an object-shape detail that matters for
        // deepEqual-based test assertions on this result.
        result: validation.missingFields
          ? { status: 'NOT_READY', reason: validation.reason, missingFields: validation.missingFields }
          : { status: 'NOT_READY', reason: validation.reason },
      });
      continue;
    }

    try {
      const assignment = await deps.assign(group.id, link.passportIdentityId, 'visitsaudi', group.departureDate);
      const batch = await deps.findBatchById(assignment.batchId);
      results.push({
        passportIdentityId: link.passportIdentityId,
        telegramMessageId: link.telegramMessageId,
        result: { status: 'ASSIGNED', batchName: batch?.batchName ?? '(unknown)', positionInBatch: assignment.positionInBatch },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      results.push({
        passportIdentityId: link.passportIdentityId,
        telegramMessageId: link.telegramMessageId,
        result: { status: 'ASSIGNMENT_FAILED', message },
      });
    }
  }

  return { kind: 'COMPLETED', results };
}
