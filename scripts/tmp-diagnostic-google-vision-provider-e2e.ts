/**
 * TEMPORARY ONE-OFF DIAGNOSTIC — not part of the production OCR pipeline.
 * End-to-end, real-API test of the actual, unmodified production
 * createGoogleVisionProvider()/googleVisionProvider (Google Cloud Vision
 * DOCUMENT_TEXT_DETECTION -> findMrzCandidateWindows ->
 * selectMrzCandidateWinner -> mapMrzToExtractionResult/
 * buildUnreadableMrzResult) against real passport photos. Never touches
 * env.OCR_PROVIDER or selectProvider() — calls createGoogleVisionProvider()
 * directly, so whichever provider is actually configured in production
 * right now is completely unaffected.
 *
 * A single real Vision API call is made per message; its raw fullText is
 * captured (via the injected detectDocumentText dependency — the exact
 * same extension point the provider itself already supports, and is
 * tested with, in tests/ocr.googleVisionProvider.test.ts) purely so this
 * script can ALSO run the same already-tested, already-production
 * findMrzCandidateWindows()/selectMrzCandidateWinner() a second time, at
 * zero extra API cost, to report itemized structural diagnostics
 * (candidate count, per-window lengths, filler presence, which window
 * won) alongside the provider's own final extraction result — reusing
 * the existing, already-tested runLocalProviderExtractDiagnostic /
 * formatLocalProviderExtractDiagnosticResult (from
 * tmp-diagnostic-local-provider-extract.ts; despite the filename, both
 * are provider-agnostic — they operate on any PassportExtractionResult)
 * for that final-result reporting, rather than reimplementing it.
 *
 * Read-only: no DB writes, no Redis, no worker/bot involvement. Never
 * logs raw OCR text, the Vision full-page text, or any MRZ/passport
 * field value — only structural counts, booleans, and (for the final
 * result) field presence + confidence level.
 */
import { ImageAnnotatorClient, protos } from '@google-cloud/vision';
import { findMrzCandidateWindows } from '../src/ocr/mrz/findMrzCandidateWindows.js';
import { parseAndValidateMrz } from '../src/ocr/mrz/parseAndValidateMrz.js';
import { selectMrzCandidateWinner } from '../src/ocr/mrz/selectMrzCandidateWinner.js';
import { createGoogleVisionProvider, type DetectDocumentTextResult } from '../src/ocr/providers/googleVisionProvider.js';
import type { VisionPage } from '../src/ocr/visual/extractIssueDateFromVisionStructure.js';
import { pool } from '../src/db/pool.js';
import { downloadTelegramPhoto } from '../src/telegram/downloadTelegramPhoto.js';
import { runLocalProviderExtractDiagnostic, formatLocalProviderExtractDiagnosticResult } from './tmp-diagnostic-local-provider-extract.js';

let realVisionClient: ImageAnnotatorClient | null = null;
function getRealVisionClient(): ImageAnnotatorClient {
  if (!realVisionClient) {
    realVisionClient = new ImageAnnotatorClient();
  }
  return realVisionClient;
}

/**
 * Same minimal DOCUMENT_TEXT_DETECTION call the provider's own default
 * dependency (detectDocumentTextReal in googleVisionProvider.ts) makes,
 * returning the SAME { fullText, pages } shape createGoogleVisionProvider's
 * extract() now destructures (duplicated here only to also capture fullText
 * for this script's own extra diagnostic pass — the provider itself is
 * never modified). Credentials are read automatically by the client library
 * (GOOGLE_APPLICATION_CREDENTIALS via Application Default Credentials);
 * this function never references a credential path itself.
 */
function makeCapturingDetectDocumentText(): {
  detect: (imageBuffer: Buffer) => Promise<DetectDocumentTextResult>;
  getCapturedFullText: () => string | null;
} {
  let captured: string | null = null;
  return {
    detect: async (imageBuffer: Buffer): Promise<DetectDocumentTextResult> => {
      const client = getRealVisionClient();
      const [response]: [protos.google.cloud.vision.v1.IAnnotateImageResponse] =
        await client.documentTextDetection(imageBuffer);
      if (response.error?.message) {
        throw new Error(response.error.message);
      }
      const fullText = response.fullTextAnnotation?.text ?? '';
      const pages = (response.fullTextAnnotation?.pages ?? []) as VisionPage[];
      captured = fullText;
      return { fullText, pages };
    },
    getCapturedFullText: () => captured,
  };
}

async function runForMessage(messageId: string): Promise<void> {
  const queryResult = await pool.query<{ telegram_photo_file_id: string }>(
    'SELECT telegram_photo_file_id FROM telegram_messages WHERE id = $1',
    [messageId],
  );
  const row = queryResult.rows[0];
  if (!row) {
    console.error(`[vision-provider-e2e] message=${messageId}: no telegram_messages row found`);
    return;
  }

  // Structural-only presence check (never the actual file id value) — helps
  // distinguish "row exists but the stored file id is empty/malformed" from
  // a genuine downstream failure, without logging any real identifier.
  console.log(
    `[vision-provider-e2e] message=${messageId}: telegram_photo_file_id present=${typeof row.telegram_photo_file_id === 'string' && row.telegram_photo_file_id.length > 0} length=${row.telegram_photo_file_id?.length ?? 0}`,
  );

  const { buffer, mimeType } = await downloadTelegramPhoto(row.telegram_photo_file_id);
  console.log(`[vision-provider-e2e] message=${messageId}: downloadTelegramPhoto OK bufferBytes=${buffer.length} mimeType=${mimeType}`);

  const { detect, getCapturedFullText } = makeCapturingDetectDocumentText();
  const provider = createGoogleVisionProvider({ detectDocumentText: detect });

  console.log(`\n[vision-provider-e2e] ===== message=${messageId} =====`);

  const diagnosticResult = await runLocalProviderExtractDiagnostic(buffer, (imageBuffer) => provider.extract(imageBuffer, mimeType));

  const capturedFullText = getCapturedFullText();
  if (capturedFullText === null) {
    console.log('[vision-provider-e2e] visionSuccess=false (Vision API call failed before returning any text)');
  } else {
    const windows = findMrzCandidateWindows(capturedFullText);
    console.log(`[vision-provider-e2e] visionSuccess=true candidateCount=${windows.length}`);

    for (const { lines, window } of windows) {
      const parsed = parseAndValidateMrz(lines);
      const parseSuccess = parsed !== null;
      const checksumValid = parsed?.valid ?? false;
      const is44x44 = window.normalizedLengths[0] === 44 && window.normalizedLengths[1] === 44;
      const hasFillerLine1 = lines[0].includes('<');
      const hasFillerLine2 = lines[1].includes('<');
      console.log(
        `[vision-provider-e2e]   window=${window.windowIndex} rawLengths=[${window.rawLengths.join(',')}] normalizedLengths=[${window.normalizedLengths.join(',')}] is44x44=${is44x44} hasFillerLine1=${hasFillerLine1} hasFillerLine2=${hasFillerLine2} parseSuccess=${parseSuccess} checksumValid=${checksumValid}`,
      );
    }

    const { validWinner } = selectMrzCandidateWinner(windows);
    console.log(`[vision-provider-e2e] validWinner=${validWinner ? `present(windowIndex=${validWinner.windowIndex})` : 'null'}`);
  }

  console.log('[vision-provider-e2e] provider.extract() final result (PII-safe — field presence + confidence only):');
  console.log(formatLocalProviderExtractDiagnosticResult(diagnosticResult));
}

async function main(): Promise<void> {
  const messageIds = process.argv.slice(2);
  if (messageIds.length === 0) {
    console.error('Usage: tsx scripts/tmp-diagnostic-google-vision-provider-e2e.ts <telegram_messages.id> [<telegram_messages.id> ...]');
    process.exitCode = 1;
    return;
  }

  try {
    for (const messageId of messageIds) {
      try {
        await runForMessage(messageId);
      } catch (error) {
        // Per-message: one failing message must not abort the rest of the
        // batch. Stack trace is PII-safe (source file/line only, never
        // OCR text or field values) and is what we actually need to find
        // the real crash site instead of guessing from .message alone.
        console.error(`[vision-provider-e2e] message=${messageId}: FAILED`);
        console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
      }
    }
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && process.argv[1].endsWith('tmp-diagnostic-google-vision-provider-e2e.ts')) {
  main().catch((error) => {
    console.error('[vision-provider-e2e] failed:', error instanceof Error ? (error.stack ?? error.message) : 'unknown error');
    process.exitCode = 1;
  });
}
