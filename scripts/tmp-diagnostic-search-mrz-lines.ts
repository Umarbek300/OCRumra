/**
 * TEMPORARY ONE-OFF DIAGNOSTIC — not part of the production OCR pipeline.
 * Calls the EXISTING, unmodified production `searchMrzLines()` (and its
 * `findMrzCandidateRegions`/`getImageDimensions` helpers) directly against
 * a real Telegram image, to test whether the pipeline itself works on a
 * DIFFERENT passport photo than the one three independent local locator
 * techniques already confirmed fails. No new detection algorithm here.
 */
import { findMrzCandidateRegions, type MrzCropCandidate } from '../src/ocr/mrz/findMrzCandidateRegions.js';
import { getImageDimensions } from '../src/ocr/mrz/getImageDimensions.js';
import { searchMrzLines, type SearchMrzLinesDependencies } from '../src/ocr/mrz/searchMrzLines.js';
import { type ParseResult } from '../src/ocr/mrz/parseAndValidateMrz.js';
import { pool } from '../src/db/pool.js';
import { downloadTelegramPhoto } from '../src/telegram/downloadTelegramPhoto.js';

// Same narrower, checksum-only semantic established across every prior
// candidate-OCR diagnostic this session: the library's own
// `ParseResult.valid` conflates true checksum correctness with unrelated
// structural checks (e.g. whether the country code is in its
// recognized-states list), so this checks only the actual check-digit
// details instead — mirrors production's own mapMrzToExtractionResult.ts
// (checkDigitValid && compositeValid) pattern.
const CHECK_DIGIT_FIELDS = [
  'documentNumberCheckDigit',
  'birthDateCheckDigit',
  'expirationDateCheckDigit',
  'compositeCheckDigit',
];

function isChecksumValid(parsed: ParseResult): boolean {
  const checkDigitDetails = parsed.details.filter((detail) => detail.field !== null && CHECK_DIGIT_FIELDS.includes(detail.field));
  if (checkDigitDetails.length === 0) return false;
  return checkDigitDetails.every((detail) => detail.valid);
}

export interface SearchMrzLinesDiagnosticResult {
  imageWidth: number;
  imageHeight: number;
  candidateCount: number;
  candidates: MrzCropCandidate[];
  parseSuccess: boolean;
  lineCount: number;
  lineLengths: number[];
  checksumValid: boolean | null;
  processingTimeMs: number;
}

export async function runSearchMrzLinesDiagnostic(
  imageBuffer: Buffer,
  deps?: SearchMrzLinesDependencies,
): Promise<SearchMrzLinesDiagnosticResult> {
  const start = Date.now();

  const { width, height } = await getImageDimensions(imageBuffer);
  const candidates = findMrzCandidateRegions(width, height);
  const result = await searchMrzLines(imageBuffer, deps);

  const processingTimeMs = Date.now() - start;

  if (!result) {
    return {
      imageWidth: width,
      imageHeight: height,
      candidateCount: candidates.length,
      candidates,
      parseSuccess: false,
      lineCount: 0,
      lineLengths: [],
      checksumValid: null,
      processingTimeMs,
    };
  }

  return {
    imageWidth: width,
    imageHeight: height,
    candidateCount: candidates.length,
    candidates,
    parseSuccess: true,
    lineCount: result.lines.length,
    lineLengths: result.lines.map((line) => line.length),
    checksumValid: isChecksumValid(result.parsed),
    processingTimeMs,
  };
}

export function formatSearchMrzLinesResult(result: SearchMrzLinesDiagnosticResult): string {
  return [
    `imageWidth=${result.imageWidth} imageHeight=${result.imageHeight}`,
    `candidateCount=${result.candidateCount}`,
    `candidates=${JSON.stringify(result.candidates)}`,
    `parseSuccess=${result.parseSuccess}`,
    `lineCount=${result.lineCount}`,
    `lineLengths=[${result.lineLengths.join(',')}]`,
    `checksumValid=${result.checksumValid === null ? 'N/A' : result.checksumValid}`,
    `processingTimeMs=${result.processingTimeMs}`,
  ].join('\n');
}

async function main(): Promise<void> {
  const messageId = process.argv[2];
  if (!messageId) {
    console.error('Usage: tsx scripts/tmp-diagnostic-search-mrz-lines.ts <telegram_messages.id>');
    process.exitCode = 1;
    return;
  }

  try {
    const result = await pool.query<{ telegram_photo_file_id: string }>(
      'SELECT telegram_photo_file_id FROM telegram_messages WHERE id = $1',
      [messageId],
    );
    const row = result.rows[0];
    if (!row) {
      console.error(`No telegram_messages row found for id=${messageId}`);
      process.exitCode = 1;
      return;
    }

    const { buffer } = await downloadTelegramPhoto(row.telegram_photo_file_id);
    const diagnosticResult = await runSearchMrzLinesDiagnostic(buffer);

    console.log('[search-mrz-lines] SEARCH_MRZ_LINES_RESULT (production searchMrzLines(), PII-safe):\n');
    console.log(formatSearchMrzLinesResult(diagnosticResult));
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && process.argv[1].endsWith('tmp-diagnostic-search-mrz-lines.ts')) {
  main().catch((error) => {
    console.error('[search-mrz-lines] failed:', error instanceof Error ? error.message : 'unknown error');
    process.exitCode = 1;
  });
}
