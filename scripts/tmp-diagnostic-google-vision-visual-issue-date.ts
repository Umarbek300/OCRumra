/**
 * TEMPORARY ONE-OFF DIAGNOSTIC/TEST — not part of the production OCR
 * pipeline. Checks whether extractDateCandidates()/inferIssueDate() (the
 * same pure, provider-agnostic functions the local/Tesseract provider
 * already uses for its visual-issue-date enrichment step) can recover
 * passport_issue_date from Google Cloud Vision's OWN fullText — reusing the
 * SINGLE documentTextDetection() call already made for MRZ extraction.
 * Exactly one real Vision API call per message; its fullText is used for
 * BOTH the MRZ parse (to get checksum-validated known dates) AND the
 * visual-zone date-candidate extraction. No second OCR call of any kind,
 * no Tesseract involved.
 *
 * Never touches src/ocr/providers/googleVisionProvider.ts, never writes to
 * the database, never enqueues/dequeues anything. Read-only DB lookup +
 * in-memory download + direct function calls only.
 *
 * PII-safe: never logs raw OCR text, the full page text, or any actual
 * date/name/number value — only counts, booleans, and a fixed confidence
 * label.
 */
import { ImageAnnotatorClient, protos } from '@google-cloud/vision';
import { findMrzCandidateWindows } from '../src/ocr/mrz/findMrzCandidateWindows.js';
import { mapMrzToExtractionResult } from '../src/ocr/mrz/mapMrzToExtractionResult.js';
import { selectMrzCandidateWinner } from '../src/ocr/mrz/selectMrzCandidateWinner.js';
import { extractDateCandidates } from '../src/ocr/visual/extractDateCandidates.js';
import { inferIssueDate } from '../src/ocr/visual/inferIssueDate.js';
import { pool } from '../src/db/pool.js';
import { downloadTelegramPhoto } from '../src/telegram/downloadTelegramPhoto.js';

// --- PII-safe regex-near-miss statistics (diagnostic-only) -----------------
//
// Answers "why did extractDateCandidates() find zero candidates" without
// ever logging the actual text: counts how many 4-digit-year-shaped tokens,
// month-name tokens, and separator-digit runs exist in the NON-MRZ part of
// the page, and how many of the 3 date regexes extractDateCandidates()
// itself uses produced a raw shape match that its own calendar-validity
// filter then rejected (a "near miss"). The 3 patterns below are
// intentionally duplicated from src/ocr/visual/extractDateCandidates.ts —
// this file never imports/modifies that production module beyond calling
// its already-exported extractDateCandidates() for the final valid count.

export interface DateLikeNearMissStatistics {
  nonMrzLineCount: number;
  fourDigitYearCount: number;
  monthTokenCount: number;
  separatorDigitPatternCount: number;
  regexShapeMatchCount: number;
  validCandidateCount: number;
  regexNearMissCount: number;
}

// No \b anchoring here either, for the same reason as MONTH_TOKEN_PATTERN
// above: a year commonly sits directly against a letter (e.g. "JAN2020")
// with no word boundary between them.
const FOUR_DIGIT_YEAR_PATTERN = /(19|20)\d{2}/g;
// No \b anchoring: a real OCR read commonly has the month abbreviation
// directly adjacent to digits with no separator (e.g. "15JAN2020", which
// extractDateCandidates()'s own TEXTUAL_MONTH_PATTERN already recognizes),
// and \b does not fire between two word characters (a digit and a letter).
const MONTH_TOKEN_PATTERN = /(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)/gi;
const SEPARATOR_DIGIT_PATTERN = /\d{1,4}[./-]\d{1,4}[./-]\d{1,4}/g;
const TEXTUAL_MONTH_DATE_PATTERN = /(\d{2})\s?(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\s?(\d{4})/g;
const NUMERIC_DATE_PATTERN = /(\d{2})[./-](\d{2})[./-](\d{4})/g;
const ISO_DATE_PATTERN = /(\d{4})-(\d{2})-(\d{2})/g;

function countMatches(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length;
}

/**
 * Same line-cleaning transform findMrzCandidateWindows() uses internally
 * (split -> strip whitespace -> uppercase -> drop empties), replicated here
 * only so the winning MRZ window's line indices line up exactly and can be
 * excluded, isolating the non-MRZ ("visual zone") text for the stats below.
 */
export function extractNonMrzText(fullText: string, mrzWindowIndex: number): string {
  const cleanedLines = fullText
    .split('\n')
    .map((line) => line.replace(/\s+/g, '').toUpperCase())
    .filter((line) => line.length > 0);
  return cleanedLines.filter((_, index) => index !== mrzWindowIndex && index !== mrzWindowIndex + 1).join('\n');
}

/**
 * Counts, never logs raw text: how much date-shaped structure exists in the
 * non-MRZ text, and how many of extractDateCandidates()'s own raw regex
 * shape-matches were rejected by its calendar-validity check (regexNearMissCount).
 * Distinguishes "the format isn't being matched at all" (all counts ~0) from
 * "shapes are being matched but rejected" (regexNearMissCount > 0).
 */
export function computeDateLikeNearMissStatistics(nonMrzText: string): DateLikeNearMissStatistics {
  const nonMrzLineCount = nonMrzText.split('\n').filter((line) => line.length > 0).length;
  const fourDigitYearCount = countMatches(nonMrzText, FOUR_DIGIT_YEAR_PATTERN);
  const monthTokenCount = countMatches(nonMrzText, MONTH_TOKEN_PATTERN);
  const separatorDigitPatternCount = countMatches(nonMrzText, SEPARATOR_DIGIT_PATTERN);
  const regexShapeMatchCount =
    countMatches(nonMrzText, TEXTUAL_MONTH_DATE_PATTERN) +
    countMatches(nonMrzText, NUMERIC_DATE_PATTERN) +
    countMatches(nonMrzText, ISO_DATE_PATTERN);
  const validCandidateCount = extractDateCandidates(nonMrzText).length;
  const regexNearMissCount = Math.max(0, regexShapeMatchCount - validCandidateCount);

  return {
    nonMrzLineCount,
    fourDigitYearCount,
    monthTokenCount,
    separatorDigitPatternCount,
    regexShapeMatchCount,
    validCandidateCount,
    regexNearMissCount,
  };
}

export function formatDateLikeNearMissStatistics(stats: DateLikeNearMissStatistics): string {
  return (
    `nonMrzLineCount=${stats.nonMrzLineCount} fourDigitYearCount=${stats.fourDigitYearCount} ` +
    `monthTokenCount=${stats.monthTokenCount} separatorDigitPatternCount=${stats.separatorDigitPatternCount} ` +
    `regexShapeMatchCount=${stats.regexShapeMatchCount} validCandidateCount=${stats.validCandidateCount} ` +
    `regexNearMissCount=${stats.regexNearMissCount}`
  );
}

let realVisionClient: ImageAnnotatorClient | null = null;
function getRealVisionClient(): ImageAnnotatorClient {
  if (!realVisionClient) {
    realVisionClient = new ImageAnnotatorClient();
  }
  return realVisionClient;
}

/** Same minimal DOCUMENT_TEXT_DETECTION call the real provider makes — exactly one per message. */
async function detectFullText(imageBuffer: Buffer): Promise<string> {
  const client = getRealVisionClient();
  const [response]: [protos.google.cloud.vision.v1.IAnnotateImageResponse] =
    await client.documentTextDetection(imageBuffer);
  if (response.error?.message) {
    throw new Error(response.error.message);
  }
  return response.fullTextAnnotation?.text ?? '';
}

async function runForTelegramMessageNumber(telegramMessageNum: string): Promise<void> {
  console.log(`\n[visual-issue-date-e2e] ===== telegram_message_num=${telegramMessageNum} =====`);

  const queryResult = await pool.query<{ telegram_photo_file_id: string }>(
    `SELECT telegram_photo_file_id FROM telegram_messages WHERE telegram_message_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [telegramMessageNum],
  );
  const row = queryResult.rows[0];
  if (!row) {
    console.log('[visual-issue-date-e2e] no telegram_messages row found for this number');
    return;
  }

  const { buffer } = await downloadTelegramPhoto(row.telegram_photo_file_id);

  let fullText: string;
  try {
    fullText = await detectFullText(buffer);
  } catch {
    console.log('[visual-issue-date-e2e] visionSuccess=false (Vision API call failed)');
    return;
  }
  console.log(`[visual-issue-date-e2e] visionSuccess=true fullTextLength=${fullText.length}`);

  // Same single fullText, pass 1: MRZ parse (already-tested production path) -> known, checksum-graded dates.
  const windows = findMrzCandidateWindows(fullText);
  const { validWinner } = selectMrzCandidateWinner(windows);
  if (!validWinner) {
    console.log('[visual-issue-date-e2e] mrzValidWinner=false -- no known dates available, cannot test issue-date recovery for this message');
    return;
  }

  const mapped = mapMrzToExtractionResult(validWinner.parsed, validWinner.lines);
  const known = [mapped.dateOfBirth.value, mapped.passportExpiryDate.value].filter(
    (value): value is string => value !== null,
  );
  console.log(`[visual-issue-date-e2e] mrzValidWinner=true knownDateCount=${known.length}`);

  // Same single fullText, pass 2: visual-zone date-candidate extraction (zero extra API cost).
  const candidates = extractDateCandidates(fullText);
  console.log(`[visual-issue-date-e2e] visualDateCandidateCount=${candidates.length}`);

  const issueDate = inferIssueDate(candidates, known);
  const found = issueDate !== null;
  console.log(`[visual-issue-date-e2e] issueDateCandidateFound=${found}`);

  if (found) {
    const isDistinctFromKnown = !known.includes(issueDate as string);
    console.log(`[visual-issue-date-e2e] validationPassed=${isDistinctFromKnown}`);
    console.log(
      '[visual-issue-date-e2e] proposedConfidence=medium (matches the existing runVisualFieldOcr/enrichWithVisualIssueDate policy in localProvider.ts -- issue date has no MRZ check digit, so it can never be "high")',
    );
  } else {
    console.log('[visual-issue-date-e2e] validationPassed=n/a (no candidate to validate)');
  }

  // PII-safe regex-near-miss diagnostics: same single fullText, no extra API call.
  const nonMrzText = extractNonMrzText(fullText, validWinner.windowIndex);
  const stats = computeDateLikeNearMissStatistics(nonMrzText);
  console.log(`[visual-issue-date-e2e] near-miss stats: ${formatDateLikeNearMissStatistics(stats)}`);
}

async function main(): Promise<void> {
  const telegramMessageNums = process.argv.slice(2);
  if (telegramMessageNums.length === 0) {
    console.error(
      'Usage: tsx scripts/tmp-diagnostic-google-vision-visual-issue-date.ts <telegram_messages.telegram_message_id> [...]',
    );
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

if (process.argv[1] && process.argv[1].endsWith('tmp-diagnostic-google-vision-visual-issue-date.ts')) {
  main().catch((error) => {
    console.error('[visual-issue-date-e2e] failed:', error instanceof Error ? error.message : 'unknown error');
    process.exitCode = 1;
  });
}
