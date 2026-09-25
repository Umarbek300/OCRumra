/**
 * TEMPORARY ONE-OFF DIAGNOSTIC/TEST — not part of the production OCR
 * pipeline. Real end-to-end check of the actual, unmodified production
 * createGoogleVisionProvider() (now wired to extractVisualIssueDate) against
 * real passport photos 270/271. Exactly ONE real Vision API call per
 * message — no second call, no Tesseract. Never writes to the database,
 * never touches the queue/worker, never modifies .env or any production
 * file.
 *
 * PII-safe: never logs raw OCR text, fullText, the full-page structure, a
 * passport number, a name, or any actual date value (issue date included)
 * — only booleans/counts/confidence-level enum labels.
 */
import { ImageAnnotatorClient, protos } from '@google-cloud/vision';
import {
  createGoogleVisionProvider,
  type DetectDocumentTextResult,
} from '../src/ocr/providers/googleVisionProvider.js';
import { findMrzCandidateWindows } from '../src/ocr/mrz/findMrzCandidateWindows.js';
import { selectMrzCandidateWinner } from '../src/ocr/mrz/selectMrzCandidateWinner.js';
import type { PassportExtractionResult } from '../src/ocr/passportExtractionSchema.js';
import { pool } from '../src/db/pool.js';
import { downloadTelegramPhoto } from '../src/telegram/downloadTelegramPhoto.js';

const ALLOWED_TELEGRAM_MESSAGE_NUMS = new Set(['270', '271']);

const FIELD_NAMES = [
  'firstName',
  'middleName',
  'surname',
  'passportNumber',
  'dateOfBirth',
  'passportIssueDate',
  'passportExpiryDate',
  'gender',
  'nationality',
  'placeOfBirth',
  'issuingAuthority',
  'mrz',
] as const satisfies readonly (keyof PassportExtractionResult)[];

/** PII-safe: present/confidence only, never the actual field value. */
function formatFieldPresence(result: PassportExtractionResult): string {
  const lines = FIELD_NAMES.map((name) => {
    const entry = result[name];
    return `  ${name}: present=${entry.value !== null} confidence=${entry.confidence ?? 'null'}`;
  });
  return [`model=${result.model}`, `overallConfidence=${result.overallConfidence}`, 'fields:', ...lines].join('\n');
}

let realVisionClient: ImageAnnotatorClient | null = null;
function getRealVisionClient(): ImageAnnotatorClient {
  if (!realVisionClient) {
    realVisionClient = new ImageAnnotatorClient();
  }
  return realVisionClient;
}

/**
 * Same minimal DOCUMENT_TEXT_DETECTION call the real provider's own default
 * dependency makes (duplicated here only so this script can ALSO inspect
 * mrzValidWinner separately, at zero extra API cost, via the already-tested
 * findMrzCandidateWindows/selectMrzCandidateWinner). The provider itself is
 * never modified.
 */
function makeCapturingDetectDocumentText(): {
  detect: (imageBuffer: Buffer) => Promise<DetectDocumentTextResult>;
  getCaptured: () => DetectDocumentTextResult | null;
} {
  let captured: DetectDocumentTextResult | null = null;
  return {
    detect: async (imageBuffer: Buffer): Promise<DetectDocumentTextResult> => {
      const client = getRealVisionClient();
      const [response]: [protos.google.cloud.vision.v1.IAnnotateImageResponse] =
        await client.documentTextDetection(imageBuffer);
      if (response.error?.message) {
        throw new Error(response.error.message);
      }
      const result: DetectDocumentTextResult = {
        fullText: response.fullTextAnnotation?.text ?? '',
        pages: (response.fullTextAnnotation?.pages ?? []) as DetectDocumentTextResult['pages'],
      };
      captured = result;
      return result;
    },
    getCaptured: () => captured,
  };
}

async function runForTelegramMessageNumber(telegramMessageId: string): Promise<void> {
  console.log(`\n[e2e-visual-issue-date] ===== telegram_message_id=${telegramMessageId} =====`);

  const queryResult = await pool.query<{ telegram_photo_file_id: string }>(
    `SELECT telegram_photo_file_id FROM telegram_messages WHERE telegram_message_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [telegramMessageId],
  );
  const row = queryResult.rows[0];
  if (!row) {
    console.log('[e2e-visual-issue-date] no telegram_messages row found for this number');
    return;
  }

  const { buffer, mimeType } = await downloadTelegramPhoto(row.telegram_photo_file_id);

  const { detect, getCaptured } = makeCapturingDetectDocumentText();
  const provider = createGoogleVisionProvider({ detectDocumentText: detect });

  const result = await provider.extract(buffer, mimeType);

  const captured = getCaptured();
  if (captured === null) {
    console.log('[e2e-visual-issue-date] visionSuccess=false (Vision API call failed)');
  } else {
    console.log(`[e2e-visual-issue-date] visionSuccess=true pageCount=${captured.pages.length}`);
    const windows = findMrzCandidateWindows(captured.fullText);
    const { validWinner } = selectMrzCandidateWinner(windows);
    console.log(`[e2e-visual-issue-date] mrzValidWinner=${validWinner !== null}`);
  }

  console.log(`[e2e-visual-issue-date] visualIssueDateFound=${result.passportIssueDate.value !== null}`);
  console.log('[e2e-visual-issue-date] provider.extract() final result (PII-safe — field presence + confidence only):');
  console.log(formatFieldPresence(result));
}

async function main(): Promise<void> {
  const telegramMessageNums = process.argv.slice(2);
  if (telegramMessageNums.length === 0) {
    console.error('Usage: tsx scripts/tmp-diagnostic-google-vision-issue-date-e2e.ts <270|271> [...]');
    process.exitCode = 1;
    return;
  }
  const invalid = telegramMessageNums.filter((num) => !ALLOWED_TELEGRAM_MESSAGE_NUMS.has(num));
  if (invalid.length > 0) {
    console.error(`This diagnostic is scoped to messages 270/271 only; rejected: ${invalid.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  try {
    for (const num of telegramMessageNums) {
      await runForTelegramMessageNumber(num);
    }
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && process.argv[1].endsWith('tmp-diagnostic-google-vision-issue-date-e2e.ts')) {
  main().catch((error) => {
    console.error('[e2e-visual-issue-date] failed:', error instanceof Error ? error.message : 'unknown error');
    process.exitCode = 1;
  });
}
