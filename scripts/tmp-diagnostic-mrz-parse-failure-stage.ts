/**
 * TEMPORARY ONE-OFF DIAGNOSTIC — not part of the production OCR pipeline.
 * Pinpoints exactly which stage of MRZ parsing/validation a real
 * Tesseract-read candidate line pair fails at: the `mrz` package's own
 * format-dispatch switch (parse.js, decided solely by lines[0].length),
 * its per-format line-length re-check (e.g. td3.js requiring both lines
 * to be exactly 44 characters), or — if both structural checks pass — a
 * genuine check-digit/checksum failure inside field-level validation
 * (which the `mrz` package never throws for; it instead marks that field
 * `valid: false` in the returned result, so a "failure" there is only
 * detectable by inspecting `.valid`, not a caught exception). Calls the
 * EXISTING, unmodified production parseAndValidateMrz() for the pass/fail
 * the pipeline itself would see, plus the same underlying `mrz` package's
 * `parse()` function directly (imported, never reimplemented) purely to
 * categorize *why* it failed when it does. Never logs OCR'd text, any MRZ
 * field value, or error message content — only a coarse structural
 * category name and line lengths.
 */
import { parse as parseMrzRaw } from 'mrz';
import { cropRegion } from '../src/ocr/mrz/cropRegion.js';
import { extractMrzLines } from '../src/ocr/mrz/extractMrzLines.js';
import { findMrzCandidateRegions } from '../src/ocr/mrz/findMrzCandidateRegions.js';
import { getImageDimensions } from '../src/ocr/mrz/getImageDimensions.js';
import { parseAndValidateMrz } from '../src/ocr/mrz/parseAndValidateMrz.js';
import { runTesseractOcr } from '../src/ocr/mrz/runTesseractOcr.js';
import { pool } from '../src/db/pool.js';
import { downloadTelegramPhoto } from '../src/telegram/downloadTelegramPhoto.js';

export type MrzParseFailureCategory =
  | 'success'
  | 'format-dispatch-unrecognized-line0-length'
  | 'td3-line-length-mismatch'
  | 'td3-line-count-mismatch'
  | 'other-structural-error'
  | 'checksum-or-field-level-invalid';

export interface MrzParseDiagnosticResult {
  lineLengths: number[];
  parseAndValidateMrzSuccess: boolean;
  failureCategory: MrzParseFailureCategory;
}

/**
 * Categorizes exactly why the `mrz` package rejects a candidate line pair
 * by calling its real, unmodified parse() directly and pattern-matching
 * only the *shape* of a thrown error's message — never logging the
 * message itself (defense in depth: never assume an error message is
 * content-free just because it is today). When parse() doesn't throw,
 * `result.valid` distinguishes a genuine success from a structurally
 * well-formed but checksum-invalid result — the one failure mode the
 * `mrz` package never surfaces as an exception at all.
 */
export function diagnoseMrzParseFailure(lines: readonly string[]): MrzParseDiagnosticResult {
  const lineLengths = lines.map((line) => line.length);
  const parseAndValidateMrzSuccess = parseAndValidateMrz(lines) !== null;

  let failureCategory: MrzParseFailureCategory;
  try {
    const result = parseMrzRaw(lines, { autocorrect: true });
    failureCategory = result.valid ? 'success' : 'checksum-or-field-level-invalid';
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (/unrecognized document format/i.test(message)) {
      failureCategory = 'format-dispatch-unrecognized-line0-length';
    } else if (/invalid number of characters for line/i.test(message)) {
      failureCategory = 'td3-line-length-mismatch';
    } else if (/invalid number of lines/i.test(message)) {
      failureCategory = 'td3-line-count-mismatch';
    } else {
      failureCategory = 'other-structural-error';
    }
  }

  return { lineLengths, parseAndValidateMrzSuccess, failureCategory };
}

export function formatMrzParseDiagnosticResult(result: MrzParseDiagnosticResult): string {
  return `lineLengths=[${result.lineLengths.join(',')}] parseAndValidateMrzSuccess=${result.parseAndValidateMrzSuccess} failureCategory=${result.failureCategory}`;
}

async function runForMessage(messageId: string): Promise<void> {
  const queryResult = await pool.query<{ telegram_photo_file_id: string }>(
    'SELECT telegram_photo_file_id FROM telegram_messages WHERE id = $1',
    [messageId],
  );
  const row = queryResult.rows[0];
  if (!row) {
    console.error(`[mrz-parse-failure-stage] message=${messageId}: no telegram_messages row found`);
    return;
  }

  const { buffer } = await downloadTelegramPhoto(row.telegram_photo_file_id);
  const { width, height } = await getImageDimensions(buffer);
  const candidates = findMrzCandidateRegions(width, height);

  console.log(`\n[mrz-parse-failure-stage] ===== message=${messageId} =====`);
  console.log(`[mrz-parse-failure-stage] image=${width}x${height}`);
  console.log(
    '[mrz-parse-failure-stage] SUMMARY (PII-safe — no OCR text, MRZ values, error message content, or credentials):',
  );

  for (const [candidateIndex, candidate] of candidates.entries()) {
    // Same call shape as searchMrzLines.ts's "search" stage.
    const cropped = await cropRegion(buffer, candidate.top, candidate.height);
    const rawText = await runTesseractOcr(cropped, { psm: 6, oem: 1 });
    const searchLines = extractMrzLines(rawText);
    const result = diagnoseMrzParseFailure(searchLines);
    console.log(`[mrz-parse-failure-stage] candidate=${candidateIndex} stage=search ${formatMrzParseDiagnosticResult(result)}`);
  }
}

async function main(): Promise<void> {
  const messageIds = process.argv.slice(2);
  if (messageIds.length === 0) {
    console.error('Usage: tsx scripts/tmp-diagnostic-mrz-parse-failure-stage.ts <telegram_messages.id> [<telegram_messages.id> ...]');
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

if (process.argv[1] && process.argv[1].endsWith('tmp-diagnostic-mrz-parse-failure-stage.ts')) {
  main().catch((error) => {
    console.error('[mrz-parse-failure-stage] failed:', error instanceof Error ? error.message : 'unknown error');
    process.exitCode = 1;
  });
}
