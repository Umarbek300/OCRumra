import { env } from '../config/env.js';
import { findAgentById } from '../db/repositories/agents.repo.js';
import { computeGroupGenderStats } from '../db/repositories/groupGenderStats.repo.js';
import { findGroupById } from '../db/repositories/groups.repo.js';
import {
  findActiveCanonicalLink,
  findApplicantPhotoAssetCandidates,
  findPassportMessageLinkByTelegramMessageId,
} from '../db/repositories/passportMessageLinks.repo.js';
import { findPassportOcrResultByTelegramMessageId } from '../db/repositories/passportOcrResult.repo.js';
import {
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
import { buildApplicantPhotoPublicUrl, buildApplicantPortraitPublicUrl } from '../visa/applicantPhotoUrl.js';
import { VISA_PERSONAL_PHOTO_URL_COLUMN } from '../visa/visaSheetColumns.js';
import { writePersonalPhotoUrlIfBlank, writePersonalPortraitUrlIfBlank } from '../visa/writePersonalPhotoUrlIfBlank.js';
import { buildGenderSummaryBlock } from './buildGenderSummaryBlock.js';
import { buildSheetRow } from './buildSheetRow.js';
import { ensureGroupSheet } from './ensureGroupSheet.js';
import { selectApplicantPhotoAssets, type SelectedApplicantPhotoAssets } from './selectApplicantPhotoAssets.js';
import { buildRealSheetTitleResolver, upsertRowInSheet, type ResolveSheetTitleByGid } from './upsertRowInSheet.js';
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
  /**
   * Whether this job's confirmation was already recorded as sent, as of the
   * SAME atomic claim markSheetSyncStarted returned for this run (see
   * syncPassportRowToSheet's own `claimed.confirmationSentAt`). This is the
   * sole duplicate-send guard — see this function's own doc comment for why
   * it is sufficient.
   */
  alreadySent: boolean;
  telegramChatId: string;
  ocrResult: Parameters<typeof buildConfirmationMessage>[0]['ocrResult'];
  agent: Parameters<typeof buildConfirmationMessage>[0]['agent'];
  packageText: string;
  depositText: string;
  balanceText: string;
  sheetRowNumber: number;
}

/**
 * Sends the post-sync Telegram confirmation, then records confirmation_sent_at
 * — in that order, never the reverse. The previous implementation called
 * markSheetSyncConfirmationSent BEFORE sending, rolling it back only if
 * sendConfirmation threw; that left a real crash window (the worker process
 * being killed/OOM'd/restarted between the successful DB write and the
 * Telegram API call actually completing) where confirmation_sent_at would be
 * permanently non-null even though no Telegram message was ever delivered —
 * exactly the production symptom observed on telegram_message 320
 * (synced_at and confirmation_sent_at both set, no corresponding Telegram
 * send ever logged). Marking AFTER a successful send closes that window: the
 * column can now only ever read "sent" when Telegram actually accepted the
 * message.
 *
 * Duplicate-send safety: `alreadySent` is read once, from the SAME atomic
 * claim markSheetSyncStarted already won for this run (status 'syncing' is
 * held exclusively for this job's id for the whole duration of
 * syncPassportRowToSheet, including this call) — so no second, concurrent
 * execution of this function can ever be in flight for the same job at the
 * same time. The only way this function runs again for an already-attempted
 * job is a LATER, SEQUENTIAL retry (e.g. a crashed worker's stale 'syncing'
 * row recovered back to 'pending' and reprocessed), which is exactly what
 * `alreadySent` guards against re-sending for.
 *
 * This still cannot make send+mark perfectly atomic across a process crash:
 * if the process is killed in the narrow window after Telegram has already
 * accepted the message but before markSheetSyncConfirmationSent commits, a
 * later retry will see alreadySent=false and send one duplicate
 * confirmation. That is a deliberate, accepted tradeoff — an occasional
 * duplicate "qabul qilindi" message is far less harmful than silently and
 * permanently recording a confirmation as sent when it never was.
 */
async function sendPassportConfirmation(input: SendPassportConfirmationInput, deps: SyncPassportRowToSheetDependencies): Promise<void> {
  if (input.alreadySent) {
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

  await deps.sendConfirmation(input.telegramChatId, text);

  // Reached only once Telegram has actually accepted the message above.
  await deps.markConfirmationSent(input.sheetSyncQueueId);
}

export interface SyncPassportRowToSheetDependencies {
  markStarted: typeof markSheetSyncStarted;
  markSynced: typeof markSheetSyncSynced;
  markFailed: typeof markSheetSyncFailed;
  markConfirmationSent: typeof markSheetSyncConfirmationSent;
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
  /** Fallback photo/portrait token source when the canonical message itself has neither — see selectApplicantPhotoAssets.ts. */
  findPhotoAssetCandidates: typeof findApplicantPhotoAssetCandidates;
  /** Re-resolves a master/tab group's CURRENT tab title live, for the single-cell photo-URL write below — upsertRow's own resolution isn't exposed back to this caller, so this mirrors readVerifiedApplicantData.ts's own "never cache a tab title" approach. */
  resolveSheetTitle: ResolveSheetTitleByGid;
  writePhotoUrl: typeof writePersonalPhotoUrlIfBlank;
  writePortraitUrl: typeof writePersonalPortraitUrlIfBlank;
  /** This server's own public base URL (VISA_PHOTOS_PUBLIC_BASE_URL) — null when unset, meaning "don't write a photo URL yet" (not an error). */
  photoPublicBaseUrl: string | null;
  now: () => Date;
}

const defaultDependencies: SyncPassportRowToSheetDependencies = {
  markStarted: markSheetSyncStarted,
  markSynced: markSheetSyncSynced,
  markFailed: markSheetSyncFailed,
  markConfirmationSent: markSheetSyncConfirmationSent,
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
  findPhotoAssetCandidates: findApplicantPhotoAssetCandidates,
  resolveSheetTitle: buildRealSheetTitleResolver(),
  writePhotoUrl: writePersonalPhotoUrlIfBlank,
  writePortraitUrl: writePersonalPortraitUrlIfBlank,
  photoPublicBaseUrl: env.VISA_PHOTOS_PUBLIC_BASE_URL ?? null,
  now: () => new Date(),
};

interface CanonicalMessageResolution {
  telegramMessageId: string;
  /** Null only when this message has no passport_message_links row at all (predates the duplicate-resolution feature, or OCR found no usable identity data) — in which case there is no (identity, group) pair to fall back across for photo/portrait assets either. */
  passportIdentityId: string | null;
}

/**
 * Resolves which telegram_message's data should actually drive this
 * (identity, group)'s Sheet row — design spec §J: an AUTO_MERGEd duplicate
 * must update the EXISTING canonical row, never append its own. A message
 * with no passport_message_links row at all (predates this feature, or OCR
 * found no usable passport number/DOB) resolves to itself, leaving every
 * pre-existing sync exactly as it always was. Also returns the link's own
 * passportIdentityId (when a link exists at all) so the caller can look up
 * photo/portrait fallback candidates across every active link for the same
 * (identity, group) — see selectApplicantPhotoAssets.ts.
 */
async function resolveCanonicalTelegramMessageId(
  telegramMessageId: string,
  groupId: string,
  deps: Pick<SyncPassportRowToSheetDependencies, 'findMessageLink' | 'findActiveCanonicalLink'>,
): Promise<CanonicalMessageResolution> {
  const link = await deps.findMessageLink(telegramMessageId);
  if (!link) {
    return { telegramMessageId, passportIdentityId: null };
  }
  const canonical = await deps.findActiveCanonicalLink(link.passportIdentityId, groupId);
  if (!canonical) {
    // No active canonical currently exists for this (identity, group) --
    // this link's own role may itself be canonical, or a reassignment
    // hasn't landed yet. Either way, syncing this message directly is safe:
    // upsertRowInSheet's own column-M lookup makes this an ordinary write,
    // never a destructive one.
    return { telegramMessageId, passportIdentityId: link.passportIdentityId };
  }
  return { telegramMessageId: canonical.telegramMessageId, passportIdentityId: link.passportIdentityId };
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
    const canonicalResolution = await resolveCanonicalTelegramMessageId(
      claimed.telegramMessageId,
      telegramMessage.groupId,
      deps,
    );
    const canonicalTelegramMessageId = canonicalResolution.telegramMessageId;
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

    // Resolves which photo/portrait token the T/V-column writes below
    // should actually use (see selectApplicantPhotoAssets.ts): the
    // canonical message's own token when it has one — the ENTIRE
    // pre-existing behavior, completely unaffected — or, only when the
    // canonical itself has neither, the most recently sent active
    // duplicate message's token for the same (identity, group). Skipped
    // entirely (no DB call at all) whenever the canonical already has both
    // of its own tokens, or has no passport_message_links row to begin
    // with, so the overwhelmingly common case pays zero extra cost.
    // Isolated in its own try/catch and defaults to exactly the
    // pre-existing "use the canonical's own token" values on any error, so
    // this optional enhancement can never make T/V worse than before it
    // existed, and never risks the already-successful sync.
    let photoAssets: SelectedApplicantPhotoAssets = {
      photoToken: ocrResult.personalPhotoToken,
      portraitToken: ocrResult.personalPortraitToken,
    };
    try {
      if (
        canonicalResolution.passportIdentityId &&
        (ocrResult.personalPhotoToken === null || ocrResult.personalPortraitToken === null)
      ) {
        const candidates = await deps.findPhotoAssetCandidates(canonicalResolution.passportIdentityId, telegramMessage.groupId);
        photoAssets = selectApplicantPhotoAssets(
          {
            telegramMessageId: canonicalTelegramMessageId,
            personalPhotoToken: ocrResult.personalPhotoToken,
            personalPortraitToken: ocrResult.personalPortraitToken,
          },
          candidates,
        );
      }
    } catch (photoAssetError) {
      console.error(
        `[sheets-sync] job ${claimed.id} synced successfully but resolving fallback photo/portrait assets failed: ${sanitizeErrorMessage(photoAssetError)}`,
      );
    }

    // Populates Sheet column T (personalPhotoUrl) with the durable
    // /visa-photos/:token URL, ONLY when a photo token is available
    // (photoAssets.photoToken — the canonical message's own token, or a
    // fallback from an active duplicate, see above) and this server has a
    // configured public base URL. The URL is built from the dedicated
    // random token, NEVER from canonicalTelegramMessageId or any other
    // existing identifier (see applicantPhotoUrl.ts). writePhotoUrl itself
    // guarantees an operator's own manually-typed value is never
    // overwritten. Isolated in its own try/catch for the same reason as
    // the gender summary above — never flips an already-synced job back
    // to failed.
    try {
      if (photoAssets.photoToken && deps.photoPublicBaseUrl) {
        const sheetTitleForPhoto =
          group?.googleSheetGid != null ? await deps.resolveSheetTitle(spreadsheetId, group.googleSheetGid) : undefined;
        const photoUrl = buildApplicantPhotoPublicUrl(deps.photoPublicBaseUrl, photoAssets.photoToken);
        await deps.writePhotoUrl(spreadsheetId, result.rowNumber, photoUrl, VISA_PERSONAL_PHOTO_URL_COLUMN, sheetTitleForPhoto);
      }
    } catch (photoUrlError) {
      console.error(
        `[sheets-sync] job ${claimed.id} synced successfully but writing the personal photo URL failed: ${sanitizeErrorMessage(photoUrlError)}`,
      );
    }

    // Populates Sheet column V (personalPortraitUrl) with the durable
    // /visa-portraits/:token URL for the CROPPED portrait — a fully
    // independent artifact/token/column from the original passport image's
    // own T-column write above (see performPassportOcr.ts and
    // uploadApplicantPhoto.ts's uploadApplicantPortrait). Deliberately NOT
    // column U: U already holds an operator-entered "passport scan URL"
    // for the unrelated VisitSaudi/KSA Visa draft-building flow (see
    // visaSheetColumns.ts's own doc comment on
    // VISA_PERSONAL_PORTRAIT_URL_COLUMN) — writing here must never touch
    // that column. buildApplicantPortraitPublicUrl (not
    // buildApplicantPhotoPublicUrl) is used deliberately, since the portrait
    // is served by its own route (applicantPortraitRoute.ts) under
    // /visa-portraits/, backed by a portrait-only token lookup — reusing the
    // T-column URL builder here would always 404. The URL is built solely
    // from photoAssets.portraitToken (the canonical message's own token, or
    // a fallback from an active duplicate — see above); no object path is
    // ever embedded. Same blank-only-write guarantee, same try/catch
    // isolation as the T-column write above — a failure here never fails
    // the sync job or affects the T-column write or the confirmation send
    // that follows.
    try {
      if (photoAssets.portraitToken && deps.photoPublicBaseUrl) {
        const sheetTitleForPortrait =
          group?.googleSheetGid != null ? await deps.resolveSheetTitle(spreadsheetId, group.googleSheetGid) : undefined;
        const portraitUrl = buildApplicantPortraitPublicUrl(deps.photoPublicBaseUrl, photoAssets.portraitToken);
        await deps.writePortraitUrl(spreadsheetId, result.rowNumber, portraitUrl, sheetTitleForPortrait);
      }
    } catch (portraitUrlError) {
      console.error(
        `[sheets-sync] job ${claimed.id} synced successfully but writing the personal portrait URL failed: ${sanitizeErrorMessage(portraitUrlError)}`,
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
          alreadySent: claimed.confirmationSentAt !== null,
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
