/**
 * TEMPORARY ONE-OFF DIAGNOSTIC — not part of the production OCR pipeline.
 * Follow-up to tmp-diagnostic-mrz-parse-failure-stage.ts, which confirmed
 * (via the real, unmodified `mrz` package) that message 270's search-stage
 * candidates all fail at format dispatch because line0 (the first MRZ
 * line) is short of the required 44 characters (40/44, 40/44, 42/43) —
 * never a checksum failure. This script asks: can any EXISTING
 * preprocessing/PSM/OEM variant recover line0 to a full 44 characters?
 *
 * Important structural fact established by reading cropRegion.ts before
 * writing this script: cropRegion() always extracts the FULL image width
 * (`sharp(imageBuffer).extract({ left: 0, top, width: metadata.width,
 * height })` — there is no horizontal/left cropping parameter anywhere in
 * the production pipeline). So a "right edge of the MRZ line getting cut
 * off" can only mean one of two things: (a) Tesseract fails to recognize
 * glyphs that ARE present in the full-width crop (a recognition problem,
 * which stronger preprocessing/PSM/OEM *can* fix — what this script
 * tests), or (b) the source photo itself doesn't frame the full MRZ zone
 * (which no crop/preprocessing change on the server can ever fix). This
 * script cannot distinguish (a) from (b) directly, but if EVERY variant
 * still caps out below 44 characters, that is itself evidence pointing
 * toward (b) rather than (a).
 *
 * Reuses only EXISTING, unmodified production building blocks
 * (findMrzCandidateRegions, cropRegion, ENHANCED_FALLBACK_ATTEMPTS,
 * runTesseractOcr, extractMrzLines, parseAndValidateMrz) plus this
 * session's own already-deployed diagnostic helpers
 * (computeMrzLineShapeMetrics, diagnoseMrzParseFailure) — nothing here
 * reimplements production logic. Read-only: no DB writes, no Redis, no
 * worker/bot involvement. Never logs OCR'd text or any MRZ field value —
 * only per-variant structural metrics.
 */
import { cropRegion, type CropRegionOptions } from '../src/ocr/mrz/cropRegion.js';
import { ENHANCED_FALLBACK_ATTEMPTS } from '../src/ocr/mrz/enhancedFallbackAttempts.js';
import { extractMrzLines } from '../src/ocr/mrz/extractMrzLines.js';
import { findMrzCandidateRegions } from '../src/ocr/mrz/findMrzCandidateRegions.js';
import { getImageDimensions } from '../src/ocr/mrz/getImageDimensions.js';
import { runTesseractOcr, type RunTesseractOptions } from '../src/ocr/mrz/runTesseractOcr.js';
import { pool } from '../src/db/pool.js';
import { downloadTelegramPhoto } from '../src/telegram/downloadTelegramPhoto.js';
import { computeMrzLineShapeMetrics } from './tmp-diagnostic-mrz-line-shape.js';
import { diagnoseMrzParseFailure } from './tmp-diagnostic-mrz-parse-failure-stage.js';

export interface PreprocessingVariant {
  name: string;
  cropOptions: CropRegionOptions;
  ocrOptions: RunTesseractOptions;
}

/**
 * A bounded, fixed set — never a dynamic cross-product — reusing exactly
 * the production ENHANCED_FALLBACK_ATTEMPTS list (the same 8 scale/
 * threshold combinations localProvider.ts's own "enhanced" stage already
 * tries) plus a small PSM sweep at the plain baseline crop (psm 7/8/13,
 * alongside the pipeline's default psm 6), since PSM/OEM aren't varied by
 * any existing production fallback stage.
 */
export const LINE0_RECOVERY_VARIANTS: readonly PreprocessingVariant[] = [
  { name: 'baseline-psm6', cropOptions: {}, ocrOptions: { psm: 6, oem: 1 } },
  { name: 'baseline-psm7', cropOptions: {}, ocrOptions: { psm: 7, oem: 1 } },
  { name: 'baseline-psm8', cropOptions: {}, ocrOptions: { psm: 8, oem: 1 } },
  { name: 'baseline-psm13', cropOptions: {}, ocrOptions: { psm: 13, oem: 1 } },
  ...ENHANCED_FALLBACK_ATTEMPTS.map((attempt) => ({
    name: `enhanced-scale${attempt.scale}-${attempt.threshold !== undefined ? `threshold${attempt.threshold}` : 'plain'}`,
    cropOptions: { scale: attempt.scale, binarize: attempt.threshold !== undefined, threshold: attempt.threshold },
    ocrOptions: { psm: 6, oem: 1 },
  })),
];

export interface VariantDiagnosticResult {
  candidateIndex: number;
  variantName: string;
  line0Length: number;
  line1Length: number;
  line0TrailingFillerCount: number;
  line0MissingFromTd3Length: number;
  line0MatchesMrzAlphabet: boolean;
  line0Reached44: boolean;
  parseSuccess: boolean;
  parseFailureCategory: string;
}

/**
 * Composes this session's already-deployed, already-tested shape/parse
 * diagnostics for one candidate/variant's OCR'd line pair. Pure — takes
 * already-computed lines, never touches the network/filesystem/OCR
 * binary itself, so this part is fully unit-testable without real image
 * data.
 */
export function buildVariantDiagnosticResult(
  candidateIndex: number,
  variantName: string,
  lines: readonly string[],
): VariantDiagnosticResult {
  const line0 = lines[0] ?? '';
  const line1 = lines[1] ?? '';
  const line0Shape = computeMrzLineShapeMetrics(line0);
  const parseResult = diagnoseMrzParseFailure(lines);

  return {
    candidateIndex,
    variantName,
    line0Length: line0Shape.length,
    line1Length: line1.length,
    line0TrailingFillerCount: line0Shape.trailingFillerCount,
    line0MissingFromTd3Length: line0Shape.missingFromTd3Length,
    line0MatchesMrzAlphabet: line0Shape.matchesMrzAlphabet,
    line0Reached44: line0Shape.length === 44,
    parseSuccess: parseResult.parseAndValidateMrzSuccess,
    parseFailureCategory: parseResult.failureCategory,
  };
}

export function formatVariantDiagnosticResult(result: VariantDiagnosticResult): string {
  return [
    `candidate=${result.candidateIndex}`,
    `variant=${result.variantName}`,
    `line0Length=${result.line0Length}`,
    `line1Length=${result.line1Length}`,
    `line0TrailingFillerCount=${result.line0TrailingFillerCount}`,
    `line0MissingFromTd3Length=${result.line0MissingFromTd3Length}`,
    `line0MatchesMrzAlphabet=${result.line0MatchesMrzAlphabet}`,
    `line0Reached44=${result.line0Reached44}`,
    `parseSuccess=${result.parseSuccess}`,
    `parseFailureCategory=${result.parseFailureCategory}`,
  ].join(' ');
}

async function runForMessage(messageId: string): Promise<void> {
  const queryResult = await pool.query<{ telegram_photo_file_id: string }>(
    'SELECT telegram_photo_file_id FROM telegram_messages WHERE id = $1',
    [messageId],
  );
  const row = queryResult.rows[0];
  if (!row) {
    console.error(`[mrz-line0-recovery-sweep] message=${messageId}: no telegram_messages row found`);
    return;
  }

  const { buffer } = await downloadTelegramPhoto(row.telegram_photo_file_id);
  const { width, height } = await getImageDimensions(buffer);
  const candidates = findMrzCandidateRegions(width, height);

  console.log(`\n[mrz-line0-recovery-sweep] ===== message=${messageId} =====`);
  console.log(`[mrz-line0-recovery-sweep] image=${width}x${height}`);
  console.log(
    '[mrz-line0-recovery-sweep] SUMMARY (PII-safe — no OCR text, MRZ values, or credentials, only structural metrics):',
  );

  for (const [candidateIndex, candidate] of candidates.entries()) {
    for (const variant of LINE0_RECOVERY_VARIANTS) {
      const cropped = await cropRegion(buffer, candidate.top, candidate.height, variant.cropOptions);
      const rawText = await runTesseractOcr(cropped, variant.ocrOptions);
      const lines = extractMrzLines(rawText);
      const result = buildVariantDiagnosticResult(candidateIndex, variant.name, lines);
      console.log(`[mrz-line0-recovery-sweep] ${formatVariantDiagnosticResult(result)}`);
    }
  }
}

async function main(): Promise<void> {
  const messageIds = process.argv.slice(2);
  if (messageIds.length === 0) {
    console.error('Usage: tsx scripts/tmp-diagnostic-mrz-line0-recovery-sweep.ts <telegram_messages.id> [<telegram_messages.id> ...]');
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

if (process.argv[1] && process.argv[1].endsWith('tmp-diagnostic-mrz-line0-recovery-sweep.ts')) {
  main().catch((error) => {
    console.error('[mrz-line0-recovery-sweep] failed:', error instanceof Error ? error.message : 'unknown error');
    process.exitCode = 1;
  });
}
