import { findAgentById } from '../db/repositories/agents.repo.js';
import {
  findActiveCanonicalLink,
  findActiveDuplicateCandidates,
  type CanonicalReassignmentCandidate,
} from '../db/repositories/passportMessageLinks.repo.js';
import { findPassportOcrResultByTelegramMessageId } from '../db/repositories/passportOcrResult.repo.js';
import {
  claimPassportOperatorCommand,
  markPassportOperatorCommandCompleted,
  markPassportOperatorCommandFailed,
  type PassportOperatorCommandRecord,
} from '../db/repositories/passportOperatorCommands.repo.js';
import { findTelegramMessageById, type TelegramMessageRecord } from '../db/repositories/telegramMessages.repo.js';
import { buildSheetRow } from '../sheets/buildSheetRow.js';
import { ensureGroupSheet } from '../sheets/ensureGroupSheet.js';
import { upsertRowInSheet } from '../sheets/upsertRowInSheet.js';
import { calculateBalance, formatMoneyForSheet, parsePackageAndDeposit } from '../telegram/parsePackageDeposit.js';
import {
  promoteReplacementAndRelocateLink,
  retireCanonicalAndPromoteReplacement,
} from './applyIdentityStateChange.js';
import { selectNewCanonical } from './selectNewCanonical.js';

const MAX_ERROR_MESSAGE_LENGTH = 300;

/** Same discipline as syncPassportRowToSheet.ts's own sanitizeErrorMessage. */
function sanitizeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'unknown error';
  return message.slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

export interface ProcessOperatorCommandDependencies {
  claim: typeof claimPassportOperatorCommand;
  markCompleted: typeof markPassportOperatorCommandCompleted;
  markFailed: typeof markPassportOperatorCommandFailed;
  findActiveCanonicalLink: typeof findActiveCanonicalLink;
  findActiveDuplicateCandidates: typeof findActiveDuplicateCandidates;
  findTelegramMessage: typeof findTelegramMessageById;
  findOcrResult: typeof findPassportOcrResultByTelegramMessageId;
  findAgent: typeof findAgentById;
  /** Only still needed for MOVE_TO_GROUP's destination side — an ordinary first-time append, never a delete/reassign (those are now handled by sheet_reconciliation_jobs, see applyIdentityStateChange.ts). */
  ensureSheet: typeof ensureGroupSheet;
  upsertRow: typeof upsertRowInSheet;
  retireAndPromote: typeof retireCanonicalAndPromoteReplacement;
  promoteAndRelocate: typeof promoteReplacementAndRelocateLink;
}

const defaultDependencies: ProcessOperatorCommandDependencies = {
  claim: claimPassportOperatorCommand,
  markCompleted: markPassportOperatorCommandCompleted,
  markFailed: markPassportOperatorCommandFailed,
  findActiveCanonicalLink,
  findActiveDuplicateCandidates,
  findTelegramMessage: findTelegramMessageById,
  findOcrResult: findPassportOcrResultByTelegramMessageId,
  findAgent: findAgentById,
  ensureSheet: ensureGroupSheet,
  upsertRow: upsertRowInSheet,
  retireAndPromote: retireCanonicalAndPromoteReplacement,
  promoteAndRelocate: promoteReplacementAndRelocateLink,
};

/** Builds the exact 12-element buildSheetRow() input for one message, from its own live OCR result + caption — never from a stale copy of another row. */
export async function buildRowForMessage(
  telegramMessageId: string,
  deps: Pick<ProcessOperatorCommandDependencies, 'findTelegramMessage' | 'findOcrResult' | 'findAgent'>,
): Promise<{ message: TelegramMessageRecord; row: string[] } | null> {
  const message = await deps.findTelegramMessage(telegramMessageId);
  const ocrResult = await deps.findOcrResult(telegramMessageId);
  if (!message || !ocrResult) {
    return null;
  }
  const agent = message.agentId ? await deps.findAgent(message.agentId) : null;
  const { packageAmount, depositAmount } = parsePackageAndDeposit(message.captionText);
  const balance = calculateBalance(packageAmount, depositAmount);
  const row = buildSheetRow({
    ocrResult,
    agent,
    packageText: packageAmount ? formatMoneyForSheet(packageAmount) : '',
    depositText: depositAmount ? formatMoneyForSheet(depositAmount) : '',
    balanceText: balance ? formatMoneyForSheet(balance) : '',
  });
  return { message, row };
}

/**
 * CANCEL_PASSPORT / REMOVE_FROM_GROUP: retires the active canonical for
 * (identityId, groupId), promotes a replacement if one exists (design spec
 * §F's confidence-score selection). Idempotent: if no active canonical
 * exists at all, this is already-done and returns immediately.
 *
 * The Sheet side is no longer touched directly here at all — retireAndPromote
 * enqueues a durable sheet_reconciliation_jobs row in the SAME transaction
 * as the domain change (see applyIdentityStateChange.ts), which the
 * reconciliation worker resolves asynchronously and crash-safely.
 */
async function retireInGroup(
  passportIdentityId: string,
  groupId: string,
  retiredStatus: 'cancelled' | 'removed',
  retireEventType: 'cancel_passport' | 'remove_from_group',
  relatedTelegramMessageId: string | null,
  operatorId: string,
  deps: ProcessOperatorCommandDependencies,
): Promise<void> {
  const activeCanonical = await deps.findActiveCanonicalLink(passportIdentityId, groupId);
  if (!activeCanonical) {
    return; // already retired — idempotent no-op
  }

  const candidates = await deps.findActiveDuplicateCandidates(passportIdentityId, groupId);
  const replacement: CanonicalReassignmentCandidate | null = selectNewCanonical(candidates);

  await deps.retireAndPromote({
    oldCanonicalLinkId: activeCanonical.id,
    oldCanonicalTelegramMessageId: activeCanonical.telegramMessageId,
    oldCanonicalRetiredStatus: retiredStatus,
    replacementLinkId: replacement?.linkId ?? null,
    passportIdentityId,
    groupId,
    retireEventType,
    reassignEventType: replacement ? 'canonical_reassigned' : null,
    relatedTelegramMessageId,
    operatorId,
    detail: replacement ? `old=${activeCanonical.telegramMessageId} new=${replacement.telegramMessageId}` : null,
  });
}

/**
 * MOVE_TO_GROUP: the moved link's OWN role/link_status never change — only
 * its group_id — since marking it 'moved' would make it invisible to
 * findActiveCanonicalLink in the destination group (see
 * applyIdentityStateChange.ts's own doc comment). fromGroupId's cleanup
 * (reassign-or-delete) is now handled entirely by a durable
 * sheet_reconciliation_jobs row, enqueued by promoteAndRelocate in the SAME
 * transaction as the domain change — no direct Sheets call happens here for
 * the origin side any more. toGroupId still gets a fresh, ordinary appended
 * row via the untouched upsertRowInSheet — a different spreadsheet has
 * never seen this message id before, so it naturally appends; this side is
 * unaffected by the P1 reconciliation work (it was never a delete/reassign).
 */
async function moveToGroup(
  passportIdentityId: string,
  fromGroupId: string,
  toGroupId: string,
  relatedTelegramMessageId: string | null,
  operatorId: string,
  deps: ProcessOperatorCommandDependencies,
): Promise<void> {
  const movedLink = await deps.findActiveCanonicalLink(passportIdentityId, fromGroupId);
  if (!movedLink) {
    return; // already moved (or never had a canonical here) — idempotent no-op
  }

  const candidates = await deps.findActiveDuplicateCandidates(passportIdentityId, fromGroupId);
  const replacement: CanonicalReassignmentCandidate | null = selectNewCanonical(candidates);

  await deps.promoteAndRelocate({
    movedLinkId: movedLink.id,
    toGroupId,
    fromGroupId,
    replacementLinkId: replacement?.linkId ?? null,
    passportIdentityId,
    relatedTelegramMessageId: relatedTelegramMessageId ?? movedLink.telegramMessageId,
    operatorId,
  });

  const { spreadsheetId: toSpreadsheetId } = await deps.ensureSheet(toGroupId);
  const builtMoved = await buildRowForMessage(movedLink.telegramMessageId, deps);
  if (builtMoved) {
    await deps.upsertRow({ spreadsheetId: toSpreadsheetId, telegramMessageId: movedLink.telegramMessageId, row: builtMoved.row });
  }
}

/**
 * Processes one passport_operator_commands job end to end: claim -> apply
 * (cancel/remove/move) -> Sheet update -> completed/failed. Mirrors
 * syncPassportRowToSheet.ts's own claim-then-try/catch shape deliberately
 * (never throws itself, records failure on the row rather than raising).
 */
export async function processPassportOperatorCommand(
  commandId: string,
  deps: ProcessOperatorCommandDependencies = defaultDependencies,
): Promise<void> {
  const claimed: PassportOperatorCommandRecord | null = await deps.claim(commandId);
  if (!claimed) {
    console.log(`[operator-command] command ${commandId} was not claimable (already processing/completed/failed); skipping`);
    return;
  }

  try {
    if (claimed.commandType === 'cancel_passport' || claimed.commandType === 'remove_from_group') {
      const groupId = claimed.groupId;
      if (!groupId) {
        throw new Error(`${claimed.commandType} command ${claimed.id} has no group_id`);
      }
      await retireInGroup(
        claimed.passportIdentityId,
        groupId,
        claimed.commandType === 'cancel_passport' ? 'cancelled' : 'removed',
        claimed.commandType,
        claimed.telegramMessageId,
        claimed.operatorId,
        deps,
      );
    } else {
      const fromGroupId = claimed.fromGroupId;
      const toGroupId = claimed.toGroupId;
      if (!fromGroupId || !toGroupId) {
        throw new Error(`move_to_group command ${claimed.id} is missing from_group_id/to_group_id`);
      }
      await moveToGroup(claimed.passportIdentityId, fromGroupId, toGroupId, claimed.telegramMessageId, claimed.operatorId, deps);
    }

    await deps.markCompleted(claimed.id);
    console.log(`[operator-command] command ${claimed.id} (${claimed.commandType}) completed`);
  } catch (error) {
    const message = sanitizeErrorMessage(error);
    await deps.markFailed(claimed.id, message);
    console.error(`[operator-command] command ${claimed.id} (${claimed.commandType}) failed: ${message}`);
  }
}
