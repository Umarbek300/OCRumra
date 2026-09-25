import { env } from '../config/env.js';
import { createPassportOcrResult, findPassportOcrResultByTelegramMessageId } from '../db/repositories/passportOcrResult.repo.js';
import { enqueueSheetSync } from '../db/repositories/sheetSyncQueue.repo.js';
import { selectProvider, type OcrProvider } from '../ocr/providers/index.js';
import { downloadTelegramPhoto } from '../telegram/downloadTelegramPhoto.js';

export interface OcrProcessingContext {
  telegramMessageId: string;
  telegramPhotoFileId: string;
  groupId: string;
  agentId: string;
}

export interface PerformPassportOcrDependencies {
  findExistingResult: typeof findPassportOcrResultByTelegramMessageId;
  downloadPhoto: typeof downloadTelegramPhoto;
  extract: OcrProvider['extract'];
  saveResult: typeof createPassportOcrResult;
  enqueueSheetSync: typeof enqueueSheetSync;
}

const defaultProvider = selectProvider(env.OCR_PROVIDER);

const defaultDependencies: PerformPassportOcrDependencies = {
  findExistingResult: findPassportOcrResultByTelegramMessageId,
  downloadPhoto: downloadTelegramPhoto,
  extract: defaultProvider.extract,
  saveResult: createPassportOcrResult,
  enqueueSheetSync,
};

/**
 * Queues this message's (already-saved) OCR result to be written to its
 * group's Google Sheet — a DB-only insert, never a Sheets API call (see
 * src/sheets/). Deliberately never lets a queueing failure propagate: a
 * Sheets-side problem (or even just this insert failing) must never turn a
 * successful OCR result into a failed passport_processing job. Idempotent
 * (telegram_message_id UNIQUE, ON CONFLICT DO NOTHING), so calling it from
 * every exit path below — a fresh save, a concurrently-stored result, or
 * an already-existing one — can never produce a duplicate queue row, and
 * safety-nets any older passport_ocr_results row that predates this queue.
 */
async function enqueueSheetSyncSafely(
  telegramMessageId: string,
  enqueue: PerformPassportOcrDependencies['enqueueSheetSync'],
): Promise<void> {
  try {
    await enqueue(telegramMessageId);
  } catch (error) {
    console.error(
      `[passport-ocr] failed to enqueue sheet sync for message ${telegramMessageId}; ` +
        'OCR result itself is unaffected, will be picked up by later reconciliation',
      error,
    );
  }
}

/**
 * The real "processing step" the worker runs for a queued job:
 * skip (idempotent) -> download from Telegram -> extract via the configured
 * OCR provider (env.OCR_PROVIDER: anthropic/local/compare) -> store the
 * result. Dependencies are injectable so tests never touch a real
 * Telegram/Anthropic/subprocess. Logs are sanitized — only the message id
 * and coarse status, never passport data.
 */
export async function performPassportOcr(
  context: OcrProcessingContext,
  deps: PerformPassportOcrDependencies = defaultDependencies,
): Promise<void> {
  const existing = await deps.findExistingResult(context.telegramMessageId);
  if (existing) {
    console.log(`[passport-ocr] result already exists for message ${context.telegramMessageId}; skipping OCR call`);
    await enqueueSheetSyncSafely(context.telegramMessageId, deps.enqueueSheetSync);
    return;
  }

  const { buffer, mimeType } = await deps.downloadPhoto(context.telegramPhotoFileId);
  const extraction = await deps.extract(buffer, mimeType);

  const stored = await deps.saveResult({
    telegramMessageId: context.telegramMessageId,
    firstName: extraction.firstName,
    middleName: extraction.middleName,
    surname: extraction.surname,
    passportNumber: extraction.passportNumber,
    dateOfBirth: extraction.dateOfBirth,
    passportIssueDate: extraction.passportIssueDate,
    passportExpiryDate: extraction.passportExpiryDate,
    gender: extraction.gender,
    nationality: extraction.nationality,
    placeOfBirth: extraction.placeOfBirth,
    issuingAuthority: extraction.issuingAuthority,
    mrz: extraction.mrz,
    overallConfidence: extraction.overallConfidence,
    rawResponse: extraction,
    provider: selectProvider(env.OCR_PROVIDER).name,
    model: extraction.model,
  });

  if (!stored) {
    // Benign race: another worker stored a result between our check above
    // and this insert. The UNIQUE constraint resolved it — not an error.
    console.log(`[passport-ocr] result was stored concurrently for message ${context.telegramMessageId}`);
  }

  await enqueueSheetSyncSafely(context.telegramMessageId, deps.enqueueSheetSync);
}
