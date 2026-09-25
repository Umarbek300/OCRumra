/**
 * TEMPORARY ONE-OFF DIAGNOSTIC — not part of the production OCR pipeline.
 * Direct follow-up to tmp-diagnostic-mrz-right-edge-geometry.ts, which
 * found that the last 5% of width in message 270's search-stage
 * candidate crops is a `likelyUniformDarkBlock` (inkRatio~0.98-0.99,
 * near-zero row-to-row variation) — far too dark and uniform to be
 * sparse printed MRZ characters, more consistent with a shadow/table
 * edge/page border sitting right at the photo's right edge. This script
 * tests directly whether that block is actively confusing Tesseract's
 * recognition of the REST of the line (e.g. by making it misjudge where
 * the line ends, or triggering a stray extra "character"), by running
 * the exact same Tesseract call the production "search" stage uses
 * (unmodified runTesseractOcr, psm 6, oem 1) on two variants of the same
 * candidate crop:
 *   - "original": the real, unmodified production cropRegion() output —
 *     the same call searchMrzLines.ts itself makes.
 *   - "masked-lastN%": the same crop, but with the last N% of width
 *     painted solid white BEFORE cropRegion's own enhancement pipeline
 *     (grayscale/normalize/upscale/sharpen, duplicated here — not
 *     imported — only because cropRegion.ts has no hook to inject a
 *     pre-built buffer or a mask option; the duplication is the
 *     unavoidable price of testing "what if this block weren't there" on
 *     a temporary basis without changing the production function). The
 *     mask itself is applied via direct raw-pixel-buffer mutation, not
 *     sharp's composite() — a local sanity check found composite() to be
 *     a silent no-op in this environment/sharp build (confirmed even for
 *     the simplest possible case, isolated from every other part of this
 *     script), while raw() extraction + in-buffer mutation + raw()
 *     reconstruction (the same technique tmp-diagnostic-mrz-right-edge-
 *     geometry.ts already uses successfully) works correctly.
 *
 * If line0 recovers meaningfully closer to (or reaches) 44 characters in
 * the masked variant, the dark block is a real recognition confounder —
 * a concrete, evidence-backed target for a future production fix. If
 * line0's length is unchanged (or the deficit is unrelated to that
 * region), the block isn't the cause and the search continues elsewhere.
 *
 * Reuses this session's own already-deployed, already-tested
 * buildVariantDiagnosticResult/formatVariantDiagnosticResult (from
 * tmp-diagnostic-mrz-line0-recovery-sweep.ts) for the PII-safe structural
 * comparison — never reimplements that logic. Read-only: no DB writes,
 * no Redis, no worker/bot involvement. Never logs OCR'd text or any MRZ
 * field value, and never logs the image itself — only structural
 * metrics.
 */
import sharp from 'sharp';
import { cropRegion } from '../src/ocr/mrz/cropRegion.js';
import { extractMrzLines } from '../src/ocr/mrz/extractMrzLines.js';
import { findMrzCandidateRegions } from '../src/ocr/mrz/findMrzCandidateRegions.js';
import { getImageDimensions } from '../src/ocr/mrz/getImageDimensions.js';
import { runTesseractOcr } from '../src/ocr/mrz/runTesseractOcr.js';
import { pool } from '../src/db/pool.js';
import { downloadTelegramPhoto } from '../src/telegram/downloadTelegramPhoto.js';
import { buildVariantDiagnosticResult, formatVariantDiagnosticResult } from './tmp-diagnostic-mrz-line0-recovery-sweep.js';

// Matches the last5% band that tmp-diagnostic-mrz-right-edge-geometry.ts
// flagged as likelyUniformDarkBlock=true on the real message this script
// targets. Kept as a single named constant so it's easy to compare
// against a different band later without hunting through the file.
const MASK_PERCENT = 5;
// cropRegion.ts's own DEFAULT_SCALE — duplicated only because this
// script's masked-variant pipeline must mirror cropRegion.ts's
// post-extract enhancement exactly (see file header for why).
const DEFAULT_SCALE = 2;

/**
 * Pure geometry: where the mask rectangle starts and how wide it is, for
 * a given crop width and mask percentage. No image I/O — fully
 * unit-testable.
 */
export function computeMaskGeometry(width: number, maskPercent: number): { maskLeft: number; maskWidth: number } {
  const maskWidth = Math.max(1, Math.round((width * maskPercent) / 100));
  const maskLeft = Math.max(0, width - maskWidth);
  return { maskLeft, maskWidth };
}

/**
 * Same extract() + grayscale/normalize/upscale/sharpen pipeline
 * cropRegion.ts applies for its default (no binarize/trim/rotate)
 * options — duplicated here (not imported/modified) solely to inject a
 * white mask over the last `maskPercent`% of width between the extract
 * and the enhancement steps, which cropRegion.ts has no parameter for.
 * The mask is applied by mutating raw grayscale-independent RGB pixel
 * bytes directly (not sharp's composite(), which was found to be a
 * silent no-op in this environment — see file header) — the same
 * raw-buffer technique already proven in
 * tmp-diagnostic-mrz-right-edge-geometry.ts.
 */
async function buildMaskedCrop(imageBuffer: Buffer, top: number, height: number, imageWidth: number, maskPercent: number): Promise<Buffer> {
  const { data, info } = await sharp(imageBuffer)
    .extract({ left: 0, top, width: imageWidth, height })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { maskLeft } = computeMaskGeometry(info.width, maskPercent);
  const channels = info.channels;
  for (let y = 0; y < info.height; y++) {
    for (let x = maskLeft; x < info.width; x++) {
      const base = (y * info.width + x) * channels;
      for (let c = 0; c < channels; c++) data[base + c] = 255;
    }
  }

  const masked = await sharp(data, { raw: { width: info.width, height: info.height, channels } }).png().toBuffer();

  const preprocessedBuffer = await sharp(masked).grayscale().normalize().png().toBuffer();
  const currentWidth = (await sharp(preprocessedBuffer).metadata()).width ?? imageWidth;

  return sharp(preprocessedBuffer)
    .resize({ width: currentWidth * DEFAULT_SCALE, kernel: 'lanczos3' })
    .sharpen()
    .png()
    .toBuffer();
}

async function runForMessage(messageId: string): Promise<void> {
  const queryResult = await pool.query<{ telegram_photo_file_id: string }>(
    'SELECT telegram_photo_file_id FROM telegram_messages WHERE id = $1',
    [messageId],
  );
  const row = queryResult.rows[0];
  if (!row) {
    console.error(`[mrz-edge-mask-ab] message=${messageId}: no telegram_messages row found`);
    return;
  }

  const { buffer } = await downloadTelegramPhoto(row.telegram_photo_file_id);
  const { width: imageWidth, height: imageHeight } = await getImageDimensions(buffer);
  const candidates = findMrzCandidateRegions(imageWidth, imageHeight);

  console.log(`\n[mrz-edge-mask-ab] ===== message=${messageId} =====`);
  console.log(`[mrz-edge-mask-ab] image=${imageWidth}x${imageHeight}`);
  console.log(`[mrz-edge-mask-ab] SUMMARY (PII-safe — no OCR text, MRZ values, or the image itself, mask=last${MASK_PERCENT}%):`);

  for (const [candidateIndex, candidate] of candidates.entries()) {
    // "original": the real, unmodified production cropRegion() — same
    // call searchMrzLines.ts's own "search" stage makes.
    const originalCrop = await cropRegion(buffer, candidate.top, candidate.height);
    const originalText = await runTesseractOcr(originalCrop, { psm: 6, oem: 1 });
    const originalLines = extractMrzLines(originalText);
    const originalResult = buildVariantDiagnosticResult(candidateIndex, 'original', originalLines);
    console.log(`[mrz-edge-mask-ab] ${formatVariantDiagnosticResult(originalResult)}`);

    // "masked-lastN%": same crop, last N% of width painted white before
    // enhancement.
    const maskedCrop = await buildMaskedCrop(buffer, candidate.top, candidate.height, imageWidth, MASK_PERCENT);
    const maskedText = await runTesseractOcr(maskedCrop, { psm: 6, oem: 1 });
    const maskedLines = extractMrzLines(maskedText);
    const maskedResult = buildVariantDiagnosticResult(candidateIndex, `masked-last${MASK_PERCENT}pct`, maskedLines);
    console.log(`[mrz-edge-mask-ab] ${formatVariantDiagnosticResult(maskedResult)}`);
  }
}

async function main(): Promise<void> {
  const messageIds = process.argv.slice(2);
  if (messageIds.length === 0) {
    console.error('Usage: tsx scripts/tmp-diagnostic-mrz-edge-mask-ab.ts <telegram_messages.id> [<telegram_messages.id> ...]');
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

if (process.argv[1] && process.argv[1].endsWith('tmp-diagnostic-mrz-edge-mask-ab.ts')) {
  main().catch((error) => {
    console.error('[mrz-edge-mask-ab] failed:', error instanceof Error ? error.message : 'unknown error');
    process.exitCode = 1;
  });
}
