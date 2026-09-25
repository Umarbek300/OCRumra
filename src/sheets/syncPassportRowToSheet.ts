import { findAgentById } from '../db/repositories/agents.repo.js';
import { findPassportOcrResultByTelegramMessageId } from '../db/repositories/passportOcrResult.repo.js';
import {
  MAX_SHEET_SYNC_ATTEMPTS,
  markSheetSyncFailed,
  markSheetSyncStarted,
  markSheetSyncSynced,
} from '../db/repositories/sheetSyncQueue.repo.js';
import { findTelegramMessageById } from '../db/repositories/telegramMessages.repo.js';
import { buildSheetRow } from './buildSheetRow.js';
import { ensureGroupSheet } from './ensureGroupSheet.js';
import { upsertRowInSheet } from './upsertRowInSheet.js';

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

export interface SyncPassportRowToSheetDependencies {
  markStarted: typeof markSheetSyncStarted;
  markSynced: typeof markSheetSyncSynced;
  markFailed: typeof markSheetSyncFailed;
  findTelegramMessage: typeof findTelegramMessageById;
  findOcrResult: typeof findPassportOcrResultByTelegramMessageId;
  findAgent: typeof findAgentById;
  ensureSheet: typeof ensureGroupSheet;
  upsertRow: typeof upsertRowInSheet;
  now: () => Date;
}

const defaultDependencies: SyncPassportRowToSheetDependencies = {
  markStarted: markSheetSyncStarted,
  markSynced: markSheetSyncSynced,
  markFailed: markSheetSyncFailed,
  findTelegramMessage: findTelegramMessageById,
  findOcrResult: findPassportOcrResultByTelegramMessageId,
  findAgent: findAgentById,
  ensureSheet: ensureGroupSheet,
  upsertRow: upsertRowInSheet,
  now: () => new Date(),
};

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

    const ocrResult = await deps.findOcrResult(claimed.telegramMessageId);
    if (!ocrResult) {
      throw new Error(`no passport_ocr_results row for telegram_message ${claimed.telegramMessageId} — nothing to sync yet`);
    }

    const agent = telegramMessage.agentId ? await deps.findAgent(telegramMessage.agentId) : null;

    const { spreadsheetId } = await deps.ensureSheet(telegramMessage.groupId);

    const row = buildSheetRow({ ocrResult, agent });
    const result = await deps.upsertRow({ spreadsheetId, telegramMessageId: claimed.telegramMessageId, row });

    await deps.markSynced(claimed.id, result.rowNumber);
    console.log(`[sheets-sync] job ${claimed.id} synced (${result.action}, sheet=${spreadsheetId}, row=${result.rowNumber})`);
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
