import { createPassportOcrResult, findPassportOcrResultByTelegramMessageId } from '../db/repositories/passportOcrResult.repo.js';
import { extractPassportData } from '../ocr/extractPassportData.js';
import { downloadTelegramPhoto } from '../telegram/downloadTelegramPhoto.js';

const OCR_PROVIDER = 'anthropic';

export interface OcrProcessingContext {
  telegramMessageId: string;
  telegramPhotoFileId: string;
  groupId: string;
  agentId: string;
}

export interface PerformPassportOcrDependencies {
  findExistingResult: typeof findPassportOcrResultByTelegramMessageId;
  downloadPhoto: typeof downloadTelegramPhoto;
  extract: typeof extractPassportData;
  saveResult: typeof createPassportOcrResult;
}

const defaultDependencies: PerformPassportOcrDependencies = {
  findExistingResult: findPassportOcrResultByTelegramMessageId,
  downloadPhoto: downloadTelegramPhoto,
  extract: extractPassportData,
  saveResult: createPassportOcrResult,
};

/**
 * The real "processing step" the worker runs for a queued job:
 * skip (idempotent) -> download from Telegram -> extract via Claude Vision
 * -> store the result. Dependencies are injectable so tests never touch a
 * real Telegram or Anthropic API. Logs are sanitized — only the message id
 * and coarse status, never passport data.
 */
export async function performPassportOcr(
  context: OcrProcessingContext,
  deps: PerformPassportOcrDependencies = defaultDependencies,
): Promise<void> {
  const existing = await deps.findExistingResult(context.telegramMessageId);
  if (existing) {
    console.log(`[passport-ocr] result already exists for message ${context.telegramMessageId}; skipping Claude call`);
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
    provider: OCR_PROVIDER,
    model: extraction.model,
  });

  if (!stored) {
    // Benign race: another worker stored a result between our check above
    // and this insert. The UNIQUE constraint resolved it — not an error.
    console.log(`[passport-ocr] result was stored concurrently for message ${context.telegramMessageId}`);
  }
}
