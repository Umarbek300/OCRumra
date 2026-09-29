import { findAgentById } from '../db/repositories/agents.repo.js';
import { computeGroupGenderStats } from '../db/repositories/groupGenderStats.repo.js';
import { findGroupById } from '../db/repositories/groups.repo.js';
import {
  findActiveCanonicalLink,
  findPassportMessageLinkByTelegramMessageId,
} from '../db/repositories/passportMessageLinks.repo.js';
import { findPassportOcrResultByTelegramMessageId } from '../db/repositories/passportOcrResult.repo.js';
import {
  clearSheetSyncConfirmationSent,
  MAX_SHEET_SYNC_ATTEMPTS,
  markSheetSyncConfirmationSent,
  markSheetSyncFailed,
  markSheetSyncStarted,
  markSheetSyncSynced,
} from '../db/repositories/sheetSyncQueue.repo.js';
import { findTelegramMessageById } from '../db/repositories/telegramMessages.repo.js';
import { buildConfirmationMessage } from '../telegram/buildConfirmationMessage.js';
import { calculateBalance, formatMoneyForSheet, parsePackageAndDeposit } from '../telegram/parsePackageDeposit.js';
import { sendConfirmationMessage } from '../telegram/sendConfirmationMessage.js';
import { buildGenderSummaryBlock } from './buildGenderSummaryBlock.js';
import { buildSheetRow } from './buildSheetRow.js';
import { ensureGroupSheet } from './ensureGroupSheet.js';
import { upsertRowInSheet } from './upsertRowInSheet.js';
import { writeGroupGenderSummary } from './writeGroupGenderSummary.js';

const MAX_ERROR_MESSAGE_LENGTH = 300;

/** Bounded like googleVisionProvider.ts's own sanitizeErrorReason — defense in depth, even though nothing here is expected to echo passport content. */
function sanitizeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'unknown error';
  return message.slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

/** Deterministic backoff, capped — no randomness, easy to reason about and to unit test. */
const BACKOFF_SCHEDULE_MINUTES = [1, 5, 30, 60] as const;

export function computeSheetSyncBackoff(attempts: number, now: () => Date = () => new Date()): Date {
  const index = Math.min(Math.max(attempts, 1), BACKOFF_SCHEDULE_MINUTES.length) - 1;
  const minutes = BACKOFF_SCHEDULE_MINUTES[index]!;
  return new Date(now().getTime() + minutes * 60_000);
}

interface SendPassportConfirmationInput {
  sheetSyncQueueId: string;
  telegramChatId: string;
  ocrResult: Parameters<typeof buildConfirmationMessage>[0]['ocrResult'];
  agent: Parameters<typeof buildConfirmationMessage>[0]['agent'];
  packageText: string;
  depositText: string;
  balanceText: string;
  sheetRowNumber: number;
}

/**
 * Claims the confirmation-send right (at-most-once, see
 * markSheetSyncConfirmationSent), sends the message, and rolls the claim
 * back if the send itself throws so a later attempt can still try. A null
 * claim result (someone already sent it) is a normal, silent no-op — not an
 * error.
 */
async function sendPassportConfirmation(input: SendPassportConfirmationInput, deps: SyncPassportRowToSheetDependencies): Promise<void> {
  const claimed = await deps.markConfirmationSent(input.sheetSyncQueueId);
  if (!claimed) {
    return;
  }

  const text = buildConfirmationMessage({
    ocrResult: input.ocrResult,
    agent: input.agent,
    packageText: input.packageText,
    depositText: input.depositText,
    balanceText: input.balanceText,
    sheetRowNumber: input.sheetRowNumber,
  });

  try {
    await deps.sendConfirmation(input.telegramChatId, text);
  } catch (error) {
    await deps.clearConfirmationSent(input.sheetSyncQueueId);
    throw error;
  }
}

export interface SyncPassportRowToSheetDependencies {
  markStarted: typeof markSheetSyncStarted;
  markSynced: typeof markSheetSyncSynced;
  markFailed: typeof markSheetSyncFailed;
  markConfirmationSent: typeof markSheetSyncConfirmationSent;
  clearConfirmationSent: typeof clearSheetSyncConfirmationSent;
  sendConfirmation: typeof sendConfirmationMessage;
  findTelegramMessage: typeof findTelegramMessageById;
  findOcrResult: typeof findPassportOcrResultByTelegramMessageId;
  findAgent: typeof findAgentById;
  findGroup: typeof findGroupById;
  ensureSheet: typeof ensureGroupSheet;
  upsertRow: typeof upsertRowInSheet;
  computeGenderStats: typeof computeGroupGenderStats;
  writeGenderSummary: typeof writeGroupGenderSummary;
  /** Duplicate-passport canonical resolution (see src/duplicates/). A message with no link (predates the feature, or OCR found no identity data) resolves to itself — pre-feature behavior is exactly preserved. */
  findMessageLink: typeof findPassportMessageLinkByTelegramMessageId;
  findActiveCanonicalLink: typeof findActiveCanonicalLink;
  now: () => Date;
}

const defaultDependencies: SyncPassportRowToSheetDependencies = {
  markStarted: markSheetSyncStarted,
  markSynced: markSheetSyncSynced,
  markFailed: markSheetSyncFailed,
  markConfirmationSent: markSheetSyncConfirmationSent,
  clearConfirmationSent: clearSheetSyncConfirmationSent,
  sendConfirmation: sendConfirmationMessage,
  findTelegramMessage: findTelegramMessageById,
  findOcrResult: findPassportOcrResultByTelegramMessageId,
  findAgent: findAgentById,
  findGroup: findGroupById,
  ensureSheet: ensureGroupSheet,
  upsertRow: upsertRowInSheet,
  computeGenderStats: computeGroupGenderStats,
  writeGenderSummary: writeGroupGenderSummary,
  findMessageLink: findPassportMessageLinkByTelegramMessageId,
  findActiveCanonicalLink,
  now: () => new Date(),
};

/**
 * Resolves which telegram_message's data should actually drive this
 * (identity, group)'s Sheet row — design spec §J: an AUTO_MERGEd duplicate
 * must update the EXISTING canonical row, never append its own. A message
 * with no passport_message_links row at all (predates this feature, or OCR
 * found no usable passport number/DOB) resolves to itself, leaving every
 * pre-existing sync exactly as it always was.
 */
async function resolveCanonicalTelegramMessageId(
  telegramMessageId: string,
  groupId: string,
  deps: Pick<SyncPassportRowToSheetDependencies, 'findMessageLink' | 'findActiveCanonicalLink'>,
): Promise<string> {
  const link = await deps.findMessageLink(telegramMessageId);
  if (!link) {
    return telegramMessageId;
  }
  const canonical = await deps.findActiveCanonicalLink(link.passportIdentityId, groupId);
  if (!canonical) {
    // No active canonical currently exists for this (identity, group) --
    // this link's own role may itself be canonical, or a reassignment
    // hasn't landed yet. Either way, syncing this message directly is safe:
    // upsertRowInSheet's own column-M lookup makes this an ordinary write,
    // never a destructive one.
    return telegramMessageId;
  }
  return canonical.telegramMessageId;
}

/**
 * Processes one sheet_sync_queue job end to end: claim -> telegram_message
 * -> group -> OCR result -> agent -> buildSheetRow -> ensureGroupSheet ->
 * upsertRowInSheet -> synced/failed. Mirrors passportWorker.ts's
 * processPassportProcessingJob shape deliberately (claim-then-try/catch,
 * never throws itself, records failure on the row rather than raising).
 *
 * Never logs OCR/MRZ/passport field values — only ids, the spreadsheet id,
 * row numbers, and bounded/sanitized error text (see sanitizeErrorMessage).
 */
export async function syncPassportRowToSheet(
  sheetSyncQueueId: string,
  deps: SyncPassportRowToSheetDependencies = defaultDependencies,
): Promise<void> {
  const claimed = await deps.markStarted(sheetSyncQueueId);
  if (!claimed) {
    console.log(`[sheets-sync] job ${sheetSyncQueueId} was not claimable (already syncing/synced, or not yet due); skipping`);
    return;
  }

  try {
    const telegramMessage = await deps.findTelegramMessage(claimed.telegramMessageId);
    if (!telegramMessage) {
      throw new Error(`telegram_message ${claimed.telegramMessageId} not found`);
    }
    if (!telegramMessage.groupId) {
      throw new Error(`telegram_message ${claimed.telegramMessageId} has no group_id — cannot determine which sheet to sync to`);
    }

    // Duplicate-passport resolution: a message that AUTO_MERGEd into an
    // existing (identity, group) canonical must update THAT row, never
    // create its own — see resolveCanonicalTelegramMessageId's doc comment.
    // A message with no link at all (pre-feature, or no usable identity
    // data) resolves to itself, so every pre-existing sync is unaffected.
    const canonicalTelegramMessageId = await resolveCanonicalTelegramMessageId(
      claimed.telegramMessageId,
      telegramMessage.groupId,
      deps,
    );
    const canonicalTelegramMessage =
      canonicalTelegramMessageId === claimed.telegramMessageId
        ? telegramMessage
        : await deps.findTelegramMessage(canonicalTelegramMessageId);
    if (!canonicalTelegramMessage) {
      throw new Error(`canonical telegram_message ${canonicalTelegramMessageId} not found`);
    }

    const ocrResult = await deps.findOcrResult(canonicalTelegramMessageId);
    if (!ocrResult) {
      throw new Error(`no passport_ocr_results row for telegram_message ${canonicalTelegramMessageId} — nothing to sync yet`);
    }

    const agent = canonicalTelegramMessage.agentId ? await deps.findAgent(canonicalTelegramMessage.agentId) : null;

    const { spreadsheetId } = await deps.ensureSheet(telegramMessage.groupId);

    // Package/Deposit/Balance come ONLY from the Telegram message's own
    // caption text — never from OCR/passport data (see
    // parsePackageDeposit.ts's own doc comment). A caption with no
    // recognizable amount, or no caption at all, yields '' for that column,
    // same as this pipeline's original always-blank behavior. Sourced from
    // the CANONICAL message, so a Sheet row's content is always driven by
    // one single, consistent source, never a mix of two messages' data.
    const { packageAmount, depositAmount } = parsePackageAndDeposit(canonicalTelegramMessage.captionText);
    const balance = calculateBalance(packageAmount, depositAmount);
    const packageText = packageAmount ? formatMoneyForSheet(packageAmount) : '';
    const depositText = depositAmount ? formatMoneyForSheet(depositAmount) : '';
    const balanceText = balance ? formatMoneyForSheet(balance) : '';

    // Fetched once here (not re-fetched below) and reused for both the
    // Sheets write target and the gender summary — a master/tab group's
    // stable gid (null for a legacy, one-dedicated-file group — upsertRow
    // then falls back to its exact prior, unchanged behavior). Never
    // resolved to a title here — that live gid -> title resolution is
    // upsertRowInSheet's own job.
    const group = await deps.findGroup(telegramMessage.groupId);

    const row = buildSheetRow({ ocrResult, agent, packageText, depositText, balanceText });
    const result = await deps.upsertRow({
      spreadsheetId,
      telegramMessageId: canonicalTelegramMessageId,
      row,
      googleSheetGid: group?.googleSheetGid,
    });

    await deps.markSynced(claimed.id, result.rowNumber);
    console.log(`[sheets-sync] job ${claimed.id} synced (${result.action}, sheet=${spreadsheetId}, row=${result.rowNumber})`);

    // The group's gender summary (O1:P5, see genderSummaryLayout.ts) is
    // always recomputed fresh from the DB and fully overwritten here — see
    // groupGenderStats.repo.ts's own doc comment for why this is correct
    // on every retry/duplicate/later-corrected-OCR-result without any
    // separate "already counted" bookkeeping. Isolated in its own
    // try/catch for the same reason as the confirmation below: a job that
    // already succeeded in the sheet must never be flipped back to
    // status='failed' just because this secondary summary write failed.
    try {
      if (!group) {
        throw new Error(`group ${telegramMessage.groupId} not found while writing its gender summary`);
      }
      const stats = await deps.computeGenderStats(telegramMessage.groupId);
      const summaryRows = buildGenderSummaryBlock(group, stats);
      await deps.writeGenderSummary(spreadsheetId, summaryRows, group.googleSheetGid);
    } catch (genderSummaryError) {
      console.error(
        `[sheets-sync] job ${claimed.id} synced successfully but the group gender summary update failed: ${sanitizeErrorMessage(genderSummaryError)}`,
      );
    }

    // Confirmation is sent strictly after the sheet write is durably marked
    // synced above, and its own failures are caught here rather than by the
    // outer catch: a job that already succeeded in the sheet must never be
    // flipped back to status='failed' (and retried/re-upserted) just because
    // the *notification* about that success didn't go through.
    try {
      await sendPassportConfirmation(
        {
          sheetSyncQueueId: claimed.id,
          telegramChatId: telegramMessage.telegramChatId,
          ocrResult,
          agent,
          packageText,
          depositText,
          balanceText,
          sheetRowNumber: result.rowNumber,
        },
        deps,
      );
    } catch (confirmationError) {
      console.error(
        `[sheets-sync] job ${claimed.id} synced successfully but confirmation send failed: ${sanitizeErrorMessage(confirmationError)}`,
      );
    }
  } catch (error) {
    const message = sanitizeErrorMessage(error);
    const nextAttemptAt = computeSheetSyncBackoff(claimed.attempts, deps.now);
    const failedRecord = await deps.markFailed(claimed.id, message, nextAttemptAt);

    // findDueSheetSyncJobs stops offering a job once its attempts reach
    // MAX_SHEET_SYNC_ATTEMPTS (see sheetSyncQueue.repo.ts) — status stays
    // 'failed' (never a new status value), still fully visible to an
    // operator querying the table directly, just no longer auto-retried.
    // claimed.attempts is the fallback only if markFailed somehow returned
    // null (id not found) — should not happen for a row this same call
    // just claimed, but never assume when logging give-up state.
    const attemptsNow = failedRecord?.attempts ?? claimed.attempts;
    if (attemptsNow >= MAX_SHEET_SYNC_ATTEMPTS) {
      console.error(
        `[sheets-sync] job ${claimed.id} permanently failed after ${attemptsNow}/${MAX_SHEET_SYNC_ATTEMPTS} attempts — ` +
          `giving up, will NOT be retried automatically (operator: review sheet_sync_queue.last_error for this row). Last error: ${message}`,
      );
    } else {
      console.error(`[sheets-sync] job ${claimed.id} failed (attempt ${attemptsNow}/${MAX_SHEET_SYNC_ATTEMPTS}), will retry: ${message}`);
    }
  }
}
