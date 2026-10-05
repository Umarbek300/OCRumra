import { env } from '../config/env.js';
import {
  createPassportOcrResult,
  findPassportOcrResultByTelegramMessageId,
  type OcrConfidenceLevel,
} from '../db/repositories/passportOcrResult.repo.js';
import { enqueueSheetSync } from '../db/repositories/sheetSyncQueue.repo.js';
import { resolveAndLinkIdentity } from '../duplicates/resolveAndLinkIdentity.js';
import { selectProvider, type OcrProvider } from '../ocr/providers/index.js';
import { downloadTelegramPhoto } from '../telegram/downloadTelegramPhoto.js';
import { extractApplicantPhotoCrop } from '../visa/extractApplicantPhotoCrop.js';
import { generateApplicantPhotoToken } from '../visa/generateApplicantPhotoToken.js';
import { uploadApplicantPhoto, uploadApplicantPortrait } from '../visa/uploadApplicantPhoto.js';

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
  /** Uploads the ORIGINAL, full, uncropped passport image buffer — the same buffer extract() above received, never a modified/cropped copy. Returns null (never throws past this call site) when photo storage isn't configured, or the upload itself failed. */
  uploadPhoto: typeof uploadApplicantPhoto;
  /**
   * Crops the applicant's printed photo region out of the SAME buffer
   * downloadPhoto already returned — never a second Telegram download, and
   * never Tesseract/local OCR (Google Vision FACE_DETECTION only). Returns
   * null (never throws past this call site) when no reliable photo region
   * could be found — callers must then skip the portrait upload entirely,
   * never upload the original full-passport buffer in its place.
   */
  extractPhotoCrop: typeof extractApplicantPhotoCrop;
  /** Uploads the CROPPED portrait buffer as a SEPARATE artifact from uploadPhoto's original passport image (never overwrites it — see uploadApplicantPhoto.ts's uploadApplicantPortrait). Returns null (never throws past this call site) when photo storage isn't configured, or the upload itself failed. */
  uploadPortrait: typeof uploadApplicantPortrait;
  /** Generates the dedicated public-URL token — called ONLY when the corresponding upload actually succeeds (see below), never derived from telegramMessageId or any other identifier. Used independently for the original photo's token and the portrait's token. */
  generateToken: typeof generateApplicantPhotoToken;
  saveResult: typeof createPassportOcrResult;
  enqueueSheetSync: typeof enqueueSheetSync;
  /** Duplicate-passport identity resolution — see src/duplicates/resolveAndLinkIdentity.ts. Injectable so tests never need real DB rows for this feature. */
  resolveIdentity: typeof resolveAndLinkIdentity;
}

const defaultProvider = selectProvider(env.OCR_PROVIDER);

const defaultDependencies: PerformPassportOcrDependencies = {
  findExistingResult: findPassportOcrResultByTelegramMessageId,
  downloadPhoto: downloadTelegramPhoto,
  extract: defaultProvider.extract,
  uploadPhoto: uploadApplicantPhoto,
  extractPhotoCrop: extractApplicantPhotoCrop,
  uploadPortrait: uploadApplicantPortrait,
  generateToken: generateApplicantPhotoToken,
  saveResult: createPassportOcrResult,
  enqueueSheetSync,
  resolveIdentity: resolveAndLinkIdentity,
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
/**
 * Resolves duplicate-passport identity for this message and reports
 * whether the Sheet-sync enqueue that follows must be suppressed. Never
 * lets a failure here block OCR from being considered successful — a
 * problem in the duplicate-detection feature must not turn a successful
 * OCR result into a failed passport_processing job, same safety principle
 * as enqueueSheetSyncSafely below. On any error, sheet sync proceeds as if
 * duplicate detection didn't exist (pre-feature behavior), rather than
 * silently dropping the message.
 */
async function resolveIdentitySafely(
  context: OcrProcessingContext,
  passportNumber: { value: string | null; confidence: OcrConfidenceLevel | null },
  dateOfBirth: { value: string | null; confidence: OcrConfidenceLevel | null },
  resolveIdentity: PerformPassportOcrDependencies['resolveIdentity'],
): Promise<boolean> {
  try {
    const outcome = await resolveIdentity({
      telegramMessageId: context.telegramMessageId,
      groupId: context.groupId,
      agentId: context.agentId,
      passportNumber,
      dateOfBirth,
    });
    return outcome.kind === 'REVIEW';
  } catch (error) {
    console.error(
      `[passport-ocr] duplicate-identity resolution failed for message ${context.telegramMessageId}; ` +
        'proceeding with sheet sync as if unresolved (never blocks OCR success)',
      error,
    );
    return false;
  }
}

export async function performPassportOcr(
  context: OcrProcessingContext,
  deps: PerformPassportOcrDependencies = defaultDependencies,
): Promise<void> {
  const existing = await deps.findExistingResult(context.telegramMessageId);
  if (existing) {
    console.log(`[passport-ocr] result already exists for message ${context.telegramMessageId}; skipping OCR call`);
    const suppressForReview = await resolveIdentitySafely(
      context,
      existing.passportNumber,
      existing.dateOfBirth,
      deps.resolveIdentity,
    );
    if (!suppressForReview) {
      await enqueueSheetSyncSafely(context.telegramMessageId, deps.enqueueSheetSync);
    }
    return;
  }

  const { buffer, mimeType } = await deps.downloadPhoto(context.telegramPhotoFileId);
  const extraction = await deps.extract(buffer, mimeType);

  // Uploads the ORIGINAL, full, uncropped passport image buffer — the
  // SAME buffer already downloaded above, never a second Telegram fetch,
  // and never a cropped copy (that is a SEPARATE artifact, uploaded
  // independently below). An upload failure (or photo storage simply not
  // being configured) must never fail OCR itself — it only ever means no
  // photo URL is available yet (see syncPassportRowToSheet.ts, which
  // treats a null path here as "nothing to sync" rather than an error).
  //
  // The public token is generated ONLY when the upload actually succeeded
  // (personalPhotoObjectPath is non-null) — never derived from
  // context.telegramMessageId or any other existing identifier, and never
  // generated at all for a row that ends up with no photo.
  let personalPhotoObjectPath: string | null = null;
  let personalPhotoToken: string | null = null;
  try {
    personalPhotoObjectPath = await deps.uploadPhoto({
      telegramMessageId: context.telegramMessageId,
      buffer,
      mimeType,
    });
    if (personalPhotoObjectPath) {
      personalPhotoToken = deps.generateToken();
    }
  } catch (error) {
    console.error(
      `[passport-ocr] failed to upload applicant photo for message ${context.telegramMessageId}; proceeding without a photo URL`,
      error,
    );
  }

  // Crops the applicant's printed portrait region out of the SAME buffer
  // downloaded above — never a second Telegram fetch, never Tesseract/
  // local OCR (Google Vision FACE_DETECTION only, see
  // extractApplicantPhotoCrop.ts). This is entirely independent of the
  // original-photo upload above: a failure here can never affect
  // personalPhotoObjectPath/Token, and a failure there (already handled
  // above) can never block this portrait step from being attempted — both
  // artifacts are always attempted from the one shared downloaded buffer.
  // The original passport buffer is NEVER replaced by, or uploaded as, the
  // cropped portrait, and vice versa.
  let personalPortraitObjectPath: string | null = null;
  let personalPortraitToken: string | null = null;
  try {
    const croppedPortrait = await deps.extractPhotoCrop(buffer, mimeType);
    if (croppedPortrait) {
      personalPortraitObjectPath = await deps.uploadPortrait({
        telegramMessageId: context.telegramMessageId,
        buffer: croppedPortrait,
        mimeType,
      });
      if (personalPortraitObjectPath) {
        personalPortraitToken = deps.generateToken();
      }
    }
  } catch (error) {
    console.error(
      `[passport-ocr] failed to crop/upload applicant portrait for message ${context.telegramMessageId}; proceeding without a portrait URL`,
      error,
    );
  }

  const stored = await deps.saveResult({
    telegramMessageId: context.telegramMessageId,
    personalPhotoObjectPath,
    personalPhotoToken,
    personalPortraitObjectPath,
    personalPortraitToken,
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

  const suppressForReview = await resolveIdentitySafely(
    context,
    extraction.passportNumber,
    extraction.dateOfBirth,
    deps.resolveIdentity,
  );
  if (!suppressForReview) {
    await enqueueSheetSyncSafely(context.telegramMessageId, deps.enqueueSheetSync);
  }
}
