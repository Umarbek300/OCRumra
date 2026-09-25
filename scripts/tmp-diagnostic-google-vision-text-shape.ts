/**
 * TEMPORARY ONE-OFF DIAGNOSTIC — not part of the production OCR pipeline.
 * Follow-up to tmp-diagnostic-google-vision-mrz.ts: that script reported
 * candidateCount=0 for real messages 270 and 271 even though the real
 * Vision DOCUMENT_TEXT_DETECTION call itself succeeded (visionSuccess=true).
 * This script answers *why* findMrzCandidateWindows() (defined there,
 * unmodified — its exact per-line filter logic is duplicated here only to
 * report per-line reasons, not to change it) found no candidate window: it
 * reports, per line of Vision's raw fullText, the same structural checks
 * findMrzCandidateWindows applies (length window, MRZ alphabet, presence
 * of the '<' filler character) plus which one first rejects that line.
 * Read-only: no DB writes, no Redis, no worker/bot involvement. Never logs
 * raw OCR text, MRZ line values, passport numbers, names, dates, or
 * credential/token content — only line counts, lengths, and booleans.
 */
import { ImageAnnotatorClient, protos } from '@google-cloud/vision';
import { pool } from '../src/db/pool.js';
import { downloadTelegramPhoto } from '../src/telegram/downloadTelegramPhoto.js';

const MAX_ERROR_MESSAGE_LENGTH = 300;
const MRZ_ALPHABET_PATTERN = /^[A-Z0-9<]+$/;
// Same window findMrzCandidateWindows (tmp-diagnostic-google-vision-mrz.ts)
// uses — duplicated here (not imported/modified) purely to explain its
// per-line reject reason.
const MIN_CANDIDATE_LENGTH = 30;
const MAX_CANDIDATE_LENGTH = 50;

export interface LineShapeSummary {
  index: number;
  rawLength: number;
  cleanedLength: number;
  hasFillerChar: boolean;
  matchesMrzAlphabet: boolean;
  withinLengthWindow: boolean;
  /** null means this line would pass all of findMrzCandidateWindows's per-line checks. */
  rejectReason: string | null;
}

export interface FullTextShapeSummary {
  fullTextLength: number;
  newlineCount: number;
  lines: LineShapeSummary[];
}

/**
 * Mirrors findMrzCandidateWindows's own per-line cleaning
 * (`.replace(/\s+/g, '').toUpperCase()`) and per-line filter conditions
 * (looksApproximatelyLikeMrzLine), but reports which one rejects each line
 * instead of silently dropping it — never the line content itself.
 */
export function summarizeFullTextShape(fullText: string): FullTextShapeSummary {
  const rawLines = fullText.split('\n');
  const lines: LineShapeSummary[] = rawLines.map((rawLine, index) => {
    const cleaned = rawLine.replace(/\s+/g, '').toUpperCase();
    const rawLength = rawLine.length;
    const cleanedLength = cleaned.length;
    const hasFillerChar = cleaned.includes('<');
    const withinLengthWindow = cleanedLength >= MIN_CANDIDATE_LENGTH && cleanedLength <= MAX_CANDIDATE_LENGTH;
    const matchesMrzAlphabet = cleanedLength > 0 && MRZ_ALPHABET_PATTERN.test(cleaned);

    let rejectReason: string | null;
    if (cleanedLength === 0) {
      rejectReason = 'empty-after-cleaning';
    } else if (!withinLengthWindow) {
      rejectReason = `length-out-of-window(${cleanedLength})`;
    } else if (!matchesMrzAlphabet) {
      rejectReason = 'non-mrz-alphabet';
    } else if (!hasFillerChar) {
      rejectReason = 'no-filler-char';
    } else {
      rejectReason = null;
    }

    return { index, rawLength, cleanedLength, hasFillerChar, matchesMrzAlphabet, withinLengthWindow, rejectReason };
  });

  return {
    fullTextLength: fullText.length,
    newlineCount: (fullText.match(/\n/g) ?? []).length,
    lines,
  };
}

export function formatFullTextShapeSummary(summary: FullTextShapeSummary): string {
  const lineLines = summary.lines.map(
    (l) =>
      `  line${l.index}: rawLength=${l.rawLength} cleanedLength=${l.cleanedLength} hasFillerChar=${l.hasFillerChar} matchesMrzAlphabet=${l.matchesMrzAlphabet} withinLengthWindow=${l.withinLengthWindow} rejectReason=${l.rejectReason ?? 'none-would-pass-per-line-filter'}`,
  );
  return [
    `fullTextLength=${summary.fullTextLength}`,
    `newlineCount=${summary.newlineCount}`,
    `lineCount=${summary.lines.length}`,
    'lines:',
    ...lineLines,
  ].join('\n');
}

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
 * Same minimal DOCUMENT_TEXT_DETECTION call as
 * tmp-diagnostic-google-vision-mrz.ts's detectDocumentTextReal (duplicated,
 * not imported, to keep this script fully standalone). Credentials are
 * read automatically by the client library; this function never
 * references the credential path itself.
 */
async function detectDocumentTextReal(imageBuffer: Buffer): Promise<string> {
  const client = getRealVisionClient();
  const [response]: [protos.google.cloud.vision.v1.IAnnotateImageResponse] =
    await client.documentTextDetection(imageBuffer);
  if (response.error?.message) {
    throw new Error(response.error.message);
  }
  return response.fullTextAnnotation?.text ?? '';
}

async function runForMessage(messageId: string): Promise<void> {
  const queryResult = await pool.query<{ telegram_photo_file_id: string }>(
    'SELECT telegram_photo_file_id FROM telegram_messages WHERE id = $1',
    [messageId],
  );
  const row = queryResult.rows[0];
  if (!row) {
    console.error(`[google-vision-text-shape] message=${messageId}: no telegram_messages row found`);
    return;
  }

  const { buffer } = await downloadTelegramPhoto(row.telegram_photo_file_id);

  console.log(`\n[google-vision-text-shape] ===== message=${messageId} =====`);
  try {
    const fullText = await detectDocumentTextReal(buffer);
    const summary = summarizeFullTextShape(fullText);
    console.log('[google-vision-text-shape] SUMMARY (PII-safe — no OCR text, MRZ values, or credentials):\n');
    console.log(formatFullTextShapeSummary(summary));
  } catch (error) {
    console.log(`visionSuccess=false errorReason=${sanitizeErrorReason(error)}`);
  }
}

async function main(): Promise<void> {
  const messageIds = process.argv.slice(2);
  if (messageIds.length === 0) {
    console.error('Usage: tsx scripts/tmp-diagnostic-google-vision-text-shape.ts <telegram_messages.id> [<telegram_messages.id> ...]');
    process.exitCode = 1;
    return;
  }

  try {
    for (const messageId of messageIds) {
      await runForMessage(messageId);
    }
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && process.argv[1].endsWith('tmp-diagnostic-google-vision-text-shape.ts')) {
  main().catch((error) => {
    console.error('[google-vision-text-shape] failed:', error instanceof Error ? error.message : 'unknown error');
    process.exitCode = 1;
  });
}
