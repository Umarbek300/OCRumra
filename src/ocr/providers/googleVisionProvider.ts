import { ImageAnnotatorClient, protos } from '@google-cloud/vision';
import { extractVisualIssueDate, type VisionPage } from '../visual/extractIssueDateFromVisionStructure.js';
import { findMrzCandidateWindows } from '../mrz/findMrzCandidateWindows.js';
import { buildUnreadableMrzResult, mapMrzToExtractionResult } from '../mrz/mapMrzToExtractionResult.js';
import { normalizeMrzDate } from '../mrz/normalizeMrzDate.js';
import { selectMrzCandidateWinner } from '../mrz/selectMrzCandidateWinner.js';
import type { PassportExtractionResult } from '../passportExtractionSchema.js';
import type { OcrProvider } from './types.js';

/** Stored in passport_ocr_results.model — never the Tesseract/local model string. */
export const GOOGLE_VISION_PROVIDER_MODEL = 'google-vision-mrz';

const MAX_ERROR_MESSAGE_LENGTH = 300;

export interface DetectDocumentTextResult {
  fullText: string;
  /** Same single Vision response's structured data — reused for visual issue-date extraction at zero extra API cost. */
  pages: VisionPage[];
}

export type DetectDocumentTextFn = (imageBuffer: Buffer) => Promise<DetectDocumentTextResult>;

export interface GoogleVisionProviderDependencies {
  detectDocumentText: DetectDocumentTextFn;
}

/**
 * Bounded the same way runTesseractOcr.ts bounds stderr — defense in
 * depth, even though Google's own error messages only ever describe
 * API/auth/quota state, never document content.
 */
function sanitizeErrorReason(error: unknown): string {
  const message = error instanceof Error ? error.message : 'unknown error';
  return message.slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

let realVisionClient: ImageAnnotatorClient | null = null;
function getRealVisionClient(): ImageAnnotatorClient {
  if (!realVisionClient) {
    realVisionClient = new ImageAnnotatorClient();
  }
  return realVisionClient;
}

/**
 * Minimal DOCUMENT_TEXT_DETECTION call — just the image buffer, no extra
 * feature types or image context. GOOGLE_APPLICATION_CREDENTIALS is read
 * automatically by @google-cloud/vision's client (Application Default
 * Credentials); this function never references a credential path itself.
 * Returns both the flat fullText (for MRZ candidate scanning) and the
 * structured pages (for visual issue-date extraction) from this SAME
 * single call — never a second Vision API call.
 */
async function detectDocumentTextReal(imageBuffer: Buffer): Promise<DetectDocumentTextResult> {
  const client = getRealVisionClient();
  const [response]: [protos.google.cloud.vision.v1.IAnnotateImageResponse] =
    await client.documentTextDetection(imageBuffer);
  if (response.error?.message) {
    throw new Error(response.error.message);
  }
  return {
    fullText: response.fullTextAnnotation?.text ?? '',
    pages: (response.fullTextAnnotation?.pages ?? []) as VisionPage[],
  };
}

const defaultDependencies: GoogleVisionProviderDependencies = {
  detectDocumentText: detectDocumentTextReal,
};

/**
 * Google Cloud Vision-backed MRZ extraction: DOCUMENT_TEXT_DETECTION on
 * the whole photo -> scan the returned full-page text for MRZ-shaped
 * 2-line windows (findMrzCandidateWindows, unmodified) -> accept only the
 * first genuinely checksum-valid one (selectMrzCandidateWinner's
 * validWinner; a structurally-shaped-but-checksum-invalid candidate is
 * never surfaced as extracted field values). Never calls Telegram/DB/
 * Redis. Never logs OCR'd text, full-page text, or MRZ field values —
 * only a bounded, sanitized error reason on Vision API failure.
 *
 * Two distinct failure shapes, deliberately handled differently:
 *  - The Vision API CALL ITSELF fails (network, quota/rate-limit,
 *    auth/permission, or any other infrastructure error) -> this now
 *    THROWS, so processPassportProcessingJob's existing catch marks the
 *    job 'failed' instead of silently recording it as a successful,
 *    completed, all-null result. An infrastructure failure must be
 *    visible and eligible for retry, not indistinguishable from a
 *    genuinely unreadable photo.
 *  - Vision SUCCEEDS but no checksum-valid MRZ is found in the photo
 *    (the !validWinner branch below) -> unchanged: still returns
 *    buildUnreadableMrzResult and the job still completes normally. This
 *    is a real, final answer about the photo, not an infra failure.
 */
export function createGoogleVisionProvider(deps: GoogleVisionProviderDependencies = defaultDependencies): OcrProvider {
  return {
    name: 'google-vision',
    // mimeType is part of the OcrProvider contract but Vision's
    // documentTextDetection() auto-detects image format from the buffer
    // itself — never forced through here.
    async extract(imageBuffer: Buffer, _mimeType: string): Promise<PassportExtractionResult> {
      let fullText: string;
      let pages: VisionPage[];
      try {
        ({ fullText, pages } = await deps.detectDocumentText(imageBuffer));
      } catch (error) {
        const reason = sanitizeErrorReason(error);
        console.log(`[google-vision] Vision API call failed: ${reason}`);
        // Infrastructure failure, not a genuine "unreadable photo" result
        // — rethrow (bounded/sanitized, same as the logged reason) so the
        // job is recorded as failed, never silently completed.
        throw new Error(`Google Vision API call failed: ${reason}`);
      }

      const windows = findMrzCandidateWindows(fullText);
      const { validWinner } = selectMrzCandidateWinner(windows);

      if (!validWinner) {
        return buildUnreadableMrzResult([], GOOGLE_VISION_PROVIDER_MODEL);
      }

      // Already-known MRZ-derived dates (DOB, expiry) — passed to
      // extractVisualIssueDate() as a safety net so a mislabeled visual row
      // never gets echoed back as a "new" issue date under a different
      // field name. Computed inline (not via mapMrzToExtractionResult.ts,
      // which this provider does not otherwise depend on for this) using
      // the same normalizeMrzDate() the mapping function itself uses.
      const knownDates = [
        normalizeMrzDate(validWinner.parsed.fields.birthDate, 'birth'),
        normalizeMrzDate(validWinner.parsed.fields.expirationDate, 'expiry'),
      ].filter((value): value is string => value !== null);
      const visualIssueDate = extractVisualIssueDate(pages, knownDates);
      console.log(`[google-vision] visualIssueDateFound=${visualIssueDate !== null}`);

      return mapMrzToExtractionResult(
        validWinner.parsed,
        validWinner.lines,
        GOOGLE_VISION_PROVIDER_MODEL,
        visualIssueDate,
      );
    },
  };
}

export const googleVisionProvider: OcrProvider = createGoogleVisionProvider();
