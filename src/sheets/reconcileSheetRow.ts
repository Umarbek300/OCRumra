import { findAgentById } from '../db/repositories/agents.repo.js';
import { findGroupById } from '../db/repositories/groups.repo.js';
import { findActiveCanonicalLink } from '../db/repositories/passportMessageLinks.repo.js';
import { findPassportOcrResultByTelegramMessageId } from '../db/repositories/passportOcrResult.repo.js';
import {
  claimReconciliationJob,
  markReconciliationJobDone,
  markReconciliationJobFailed,
  type SheetReconciliationJobRecord,
} from '../db/repositories/sheetReconciliation.repo.js';
import { findTelegramMessageById } from '../db/repositories/telegramMessages.repo.js';
import { buildRowForMessage } from '../duplicates/processOperatorCommand.js';
import { deleteCanonicalRow } from './deleteRowInSheet.js';
import { ensureGroupSheet } from './ensureGroupSheet.js';
import { reassignCanonicalRow } from './reassignCanonicalRowInSheet.js';
import { computeSheetSyncBackoff } from './syncPassportRowToSheet.js';

const MAX_ERROR_MESSAGE_LENGTH = 300;

function sanitizeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'unknown error';
  return message.slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

export interface ReconcileSheetRowDependencies {
  claim: typeof claimReconciliationJob;
  markDone: typeof markReconciliationJobDone;
  markFailed: typeof markReconciliationJobFailed;
  findActiveCanonicalLink: typeof findActiveCanonicalLink;
  ensureSheet: typeof ensureGroupSheet;
  deleteRow: typeof deleteCanonicalRow;
  reassignRow: typeof reassignCanonicalRow;
  findTelegramMessage: typeof findTelegramMessageById;
  findOcrResult: typeof findPassportOcrResultByTelegramMessageId;
  findAgent: typeof findAgentById;
  findGroup: typeof findGroupById;
}

const defaultDependencies: ReconcileSheetRowDependencies = {
  claim: claimReconciliationJob,
  markDone: markReconciliationJobDone,
  markFailed: markReconciliationJobFailed,
  findActiveCanonicalLink,
  ensureSheet: ensureGroupSheet,
  deleteRow: deleteCanonicalRow,
  reassignRow: reassignCanonicalRow,
  findTelegramMessage: findTelegramMessageById,
  findOcrResult: findPassportOcrResultByTelegramMessageId,
  findAgent: findAgentById,
  findGroup: findGroupById,
};

/**
 * Processes one sheet_reconciliation_jobs row: claim -> re-resolve the
 * CURRENT target fresh from Postgres -> reassign or delete -> done/failed.
 * Mirrors syncPassportRowToSheet.ts's own claim-then-try/catch shape
 * (never throws itself, records failure on the row rather than raising).
 *
 * Deliberately does NOT trust anything about "what this job was for"
 * beyond expected_old_canonical_telegram_message_id (the anchor used to
 * LOCATE the row via column M) and sourceOperation (used ONLY for the
 * merge-vs-everything-else branch below, never for anything else). For
 * every operation except merge ("slot mode"), the actual decision —
 * reassign to a new canonical, or delete because none remains — is
 * re-derived from a FRESH findActiveCanonicalLink read every single time
 * this runs, never from a value captured when the job was enqueued. This
 * is what makes recovery correct regardless of how many other operations
 * stacked up on the same (identity, group) before this job got processed,
 * and regardless of processing order across multiple stacked jobs — each
 * job's fresh read always lands on the CURRENT truth, and a job whose
 * anchor no longer exists in the Sheet (superseded by an earlier job that
 * already fixed things up) resolves via deleteCanonicalRow/
 * reassignCanonicalRow's own 'not_found' outcome, which this function
 * treats as success, not failure.
 *
 * merge is the one exception ("retire mode", branched on first below): a
 * same-group merge conflict permanently demotes one specific message's
 * link, a one-way transition, so its row is unconditionally stale and
 * always deleted — never reassigned, because whatever DOES currently hold
 * that (identity, group)'s canonical slot already has its OWN separate,
 * independently-synced row (that's structurally how a same-group merge
 * conflict arises in the first place); reassigning here would create a
 * duplicate row rather than clean up a stale one. See the branch itself
 * for the full reasoning.
 */
export async function reconcileSheetRow(jobId: string, deps: ReconcileSheetRowDependencies = defaultDependencies): Promise<void> {
  const claimed: SheetReconciliationJobRecord | null = await deps.claim(jobId);
  if (!claimed) {
    console.log(`[sheet-reconciliation] job ${jobId} was not claimable (already processing/done/failed-exhausted); skipping`);
    return;
  }

  try {
    const { spreadsheetId } = await deps.ensureSheet(claimed.groupId);
    // A master/tab group's stable gid (null/absent for a legacy group —
    // deleteCanonicalRow then falls back to its exact prior, unchanged
    // behavior). Never resolved to a title here — deleteCanonicalRow's own
    // live gid -> title resolution handles that.
    const googleSheetGid = (await deps.findGroup(claimed.groupId))?.googleSheetGid;

    if (claimed.sourceOperation === 'merge') {
      // Retire mode: a merge's same-group conflict resolution permanently
      // demotes ONE specific message's link to role='duplicate' — a
      // one-way transition in this schema (nothing ever promotes a
      // link back to canonical for the identity it was just demoted
      // under). Its anchor row is therefore unconditionally stale,
      // regardless of whatever the (identity, group)'s canonical turns
      // out to be by the time this job runs — and whatever DOES currently
      // hold that canonical slot was, by construction of how a same-group
      // merge conflict can arise, already independently synced under its
      // OWN row (either the survivor's untouched pre-existing canonical,
      // or the loser's own pre-existing canonical that won the conflict).
      // Reassigning the anchor to it would therefore create a DUPLICATE
      // row, not fix a stale one — so this is always a delete, never a
      // fresh findActiveCanonicalLink-driven reassign.
      await deps.deleteRow({ spreadsheetId, expectedCanonicalTelegramMessageId: claimed.expectedOldCanonicalTelegramMessageId, googleSheetGid });
      await deps.markDone(claimed.id);
      console.log(`[sheet-reconciliation] job ${claimed.id} (${claimed.sourceOperation}) done`);
      return;
    }

    // Slot mode (cancel_passport / remove_from_group / move_to_group /
    // split): the anchor row represents a (identity, group) canonical SLOT
    // that must keep accurately reflecting current truth. Re-resolved
    // fresh here, never trusted from enqueue time — see this function's
    // own doc comment.
    const currentCanonical = await deps.findActiveCanonicalLink(claimed.passportIdentityId, claimed.groupId);

    if (currentCanonical) {
      const built = await buildRowForMessage(currentCanonical.telegramMessageId, deps);
      if (!built) {
        throw new Error(
          `reconcileSheetRow: no message/OCR data for current canonical ${currentCanonical.telegramMessageId} — cannot build its row`,
        );
      }
      await deps.reassignRow({
        spreadsheetId,
        oldCanonicalTelegramMessageId: claimed.expectedOldCanonicalTelegramMessageId,
        newCanonicalTelegramMessageId: currentCanonical.telegramMessageId,
        row: built.row,
        googleSheetGid,
      });
    } else {
      await deps.deleteRow({ spreadsheetId, expectedCanonicalTelegramMessageId: claimed.expectedOldCanonicalTelegramMessageId, googleSheetGid });
    }

    await deps.markDone(claimed.id);
    console.log(`[sheet-reconciliation] job ${claimed.id} (${claimed.sourceOperation}) done`);
  } catch (error) {
    const message = sanitizeErrorMessage(error);
    const nextAttemptAt = computeSheetSyncBackoff(claimed.attempts);
    await deps.markFailed(claimed.id, message, nextAttemptAt);
    console.error(`[sheet-reconciliation] job ${claimed.id} (${claimed.sourceOperation}) failed: ${message}`);
  }
}
