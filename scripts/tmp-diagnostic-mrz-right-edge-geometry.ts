/**
 * TEMPORARY ONE-OFF DIAGNOSTIC — not part of the production OCR pipeline.
 * Follow-up to tmp-diagnostic-mrz-line0-recovery-sweep.ts, which showed
 * that no existing preprocessing/PSM/OEM variant recovers message 270's
 * line0 to the required 44 characters — the deficit survived every
 * recognition-side variant tried. This script asks a different question,
 * about the SOURCE PHOTO itself rather than OCR recognition: does the
 * original image actually contain visual content (ink/contrast) all the
 * way to where a complete MRZ line's right edge would be, or does the
 * photographed content itself run out first (a framing/crop issue no
 * server-side preprocessing could ever fix)?
 *
 * Never runs Tesseract and never reads OCR'd text — this is pure pixel
 * statistics on the raw (grayscale, unenhanced) candidate crop: per
 * right-edge percentage band (last 5/10/15/20% of width), mean pixel
 * intensity, intensity stdev (a contrast/uniformity proxy — a blank
 * background band has near-zero stdev; a band with printed characters
 * has meaningfully higher stdev), and "ink ratio" (fraction of
 * sufficiently dark pixels, using the same 150 threshold
 * cropRegion.ts's own binarization option defaults to). From those,
 * estimates the rightmost point (as % of width) where a real ink signal
 * still exists, scanning inward from the right edge — i.e. an estimate
 * of where the photographed content itself ends, independent of what
 * Tesseract managed to recognize.
 *
 * Also directly confirms, from the real image, the structural fact
 * already established by reading cropRegion.ts's source: the crop always
 * spans the image's full pixel width (no horizontal/left crop parameter
 * exists anywhere in the production pipeline), so the crop's right edge
 * IS the original photo's right edge — there is no server-side
 * right-edge truncation to find.
 *
 * A single "ink ratio" threshold cannot by itself tell dense MRZ text
 * apart from a solid dark region (a shadow, table surface, or the page's
 * own border) sitting right at the image edge — a real photo's first run
 * against this script showed the last-5%-of-width band at ~98-99% ink
 * ratio, far higher than printed text ever produces (an MRZ character
 * line is mostly background between/around glyphs, typically far under
 * 50% ink), so that reading is far more consistent with a uniform dark
 * block than with text. To tell these apart, this script also computes
 * each band's PER-ROW ink ratio and reports its stdev across rows: a
 * uniform dark block has nearly the same (high) ink ratio in every row
 * (low stdev); real text only occupies specific narrow row-bands within
 * the crop, with much lighter rows in between and around it (high
 * stdev). `likelyUniformDarkBlock` flags a band whose own ink ratio is
 * high AND whose row-to-row ink ratio barely varies — the signature of a
 * non-text region, not evidence either way about where MRZ text itself
 * ends.
 *
 * Reuses only EXISTING, unmodified production building blocks
 * (findMrzCandidateRegions, getImageDimensions) plus the `sharp` library
 * cropRegion.ts itself already depends on, for a raw (non-enhanced) pixel
 * extraction. Read-only: no DB writes, no Redis, no worker/bot
 * involvement. Never logs OCR'd text, MRZ field values, or the image
 * itself — only per-band numeric statistics.
 */
import sharp from 'sharp';
import { findMrzCandidateRegions } from '../src/ocr/mrz/findMrzCandidateRegions.js';
import { getImageDimensions } from '../src/ocr/mrz/getImageDimensions.js';
import { pool } from '../src/db/pool.js';
import { downloadTelegramPhoto } from '../src/telegram/downloadTelegramPhoto.js';

// Same binarization threshold cropRegion.ts's own DEFAULT_THRESHOLD_VALUE
// uses, reused here purely as an "is this pixel dark enough to be ink"
// cutoff for statistics — not applied to the image itself.
const INK_THRESHOLD = 150;
// A column band whose ink ratio is at or below this is treated as
// background/margin noise, not genuine printed content.
const NOISE_FLOOR_INK_RATIO = 0.03;
const RIGHT_EDGE_BAND_PERCENTS = [5, 10, 15, 20] as const;
// A band is classified as a likely uniform dark block (not text) when its
// overall ink ratio is at or above this AND its row-to-row ink ratio
// barely varies (see UNIFORM_BLOCK_ROW_STDEV_MAX below). Real MRZ text is
// mostly background between/around glyphs, so a band this consistently
// dark is a strong signal either way.
const UNIFORM_BLOCK_INK_RATIO_MIN = 0.7;
const UNIFORM_BLOCK_ROW_STDEV_MAX = 0.15;

export interface ColumnBandStats {
  bandPercent: number;
  meanIntensity: number;
  stdevIntensity: number;
  inkRatio: number;
  rowInkRatioStdev: number;
  likelyUniformDarkBlock: boolean;
}

export interface RightEdgeGeometryMetrics {
  width: number;
  height: number;
  bands: ColumnBandStats[];
  estimatedContentRightEdgePercent: number;
  distanceFromImageRightEdgePercent: number;
}

/**
 * Mean/stdev/ink-ratio over one [xStart, xEnd) column range of a
 * grayscale raw pixel buffer (row-major, 1 byte/pixel). Pure numeric
 * aggregation — never reconstructs or exposes the image, only summary
 * numbers over a pixel region.
 */
export function computeBandStats(
  data: Uint8Array | Buffer,
  width: number,
  height: number,
  xStart: number,
  xEnd: number,
  threshold: number = INK_THRESHOLD,
): { meanIntensity: number; stdevIntensity: number; inkRatio: number } {
  let sum = 0;
  let sumSquares = 0;
  let inkCount = 0;
  let n = 0;

  for (let y = 0; y < height; y++) {
    const rowOffset = y * width;
    for (let x = Math.max(0, xStart); x < Math.min(width, xEnd); x++) {
      const value = data[rowOffset + x] ?? 0;
      sum += value;
      sumSquares += value * value;
      if (value < threshold) inkCount++;
      n++;
    }
  }

  const meanIntensity = n > 0 ? sum / n : 0;
  const variance = n > 0 ? sumSquares / n - meanIntensity * meanIntensity : 0;
  const stdevIntensity = Math.sqrt(Math.max(0, variance));
  const inkRatio = n > 0 ? inkCount / n : 0;

  return { meanIntensity, stdevIntensity, inkRatio };
}

/**
 * Per-row ink ratio within one [xStart, xEnd) column range — one number
 * per row, never the row's actual pixel values. Real printed text rows
 * and blank/margin rows within the same band produce very different
 * ratios; a uniform dark block produces nearly the same ratio on every
 * row.
 */
export function computeRowInkRatios(
  data: Uint8Array | Buffer,
  width: number,
  height: number,
  xStart: number,
  xEnd: number,
  threshold: number = INK_THRESHOLD,
): number[] {
  const clampedStart = Math.max(0, xStart);
  const clampedEnd = Math.min(width, xEnd);
  const bandWidth = Math.max(0, clampedEnd - clampedStart);

  const ratios: number[] = [];
  for (let y = 0; y < height; y++) {
    const rowOffset = y * width;
    let count = 0;
    for (let x = clampedStart; x < clampedEnd; x++) {
      if ((data[rowOffset + x] ?? 0) < threshold) count++;
    }
    ratios.push(bandWidth > 0 ? count / bandWidth : 0);
  }
  return ratios;
}

function stdevOf(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * Scans narrow column strips from the right edge inward, returning the
 * rightmost strip's right boundary (as a percentage of width) whose ink
 * ratio still exceeds the noise floor — an estimate of where genuine
 * printed content ends, independent of anything Tesseract did or didn't
 * recognize.
 */
export function estimateContentRightEdgePercent(
  data: Uint8Array | Buffer,
  width: number,
  height: number,
  threshold: number = INK_THRESHOLD,
  noiseFloor: number = NOISE_FLOOR_INK_RATIO,
  stepPercent = 1,
): number {
  const stepWidth = Math.max(1, Math.round((width * stepPercent) / 100));
  for (let xEnd = width; xEnd > 0; xEnd -= stepWidth) {
    const xStart = Math.max(0, xEnd - stepWidth);
    const { inkRatio } = computeBandStats(data, width, height, xStart, xEnd, threshold);
    if (inkRatio > noiseFloor) {
      return (xEnd / width) * 100;
    }
  }
  return 0;
}

export function computeRightEdgeGeometryMetrics(data: Uint8Array | Buffer, width: number, height: number): RightEdgeGeometryMetrics {
  const bands: ColumnBandStats[] = RIGHT_EDGE_BAND_PERCENTS.map((bandPercent) => {
    const bandWidth = Math.max(1, Math.round((width * bandPercent) / 100));
    const xStart = Math.max(0, width - bandWidth);
    const { meanIntensity, stdevIntensity, inkRatio } = computeBandStats(data, width, height, xStart, width);
    const rowInkRatioStdev = stdevOf(computeRowInkRatios(data, width, height, xStart, width));
    const likelyUniformDarkBlock = inkRatio >= UNIFORM_BLOCK_INK_RATIO_MIN && rowInkRatioStdev <= UNIFORM_BLOCK_ROW_STDEV_MAX;
    return { bandPercent, meanIntensity, stdevIntensity, inkRatio, rowInkRatioStdev, likelyUniformDarkBlock };
  });

  const estimatedContentRightEdgePercent = estimateContentRightEdgePercent(data, width, height);

  return {
    width,
    height,
    bands,
    estimatedContentRightEdgePercent,
    distanceFromImageRightEdgePercent: 100 - estimatedContentRightEdgePercent,
  };
}

export function formatRightEdgeGeometryMetrics(candidateIndex: number, metrics: RightEdgeGeometryMetrics): string {
  const bandLines = metrics.bands.map(
    (b) =>
      `  band=last${b.bandPercent}% meanIntensity=${b.meanIntensity.toFixed(1)} stdevIntensity=${b.stdevIntensity.toFixed(1)} inkRatio=${b.inkRatio.toFixed(4)} rowInkRatioStdev=${b.rowInkRatioStdev.toFixed(4)} likelyUniformDarkBlock=${b.likelyUniformDarkBlock}`,
  );
  return [
    `[mrz-right-edge-geometry] candidate=${candidateIndex} cropWidth=${metrics.width} cropHeight=${metrics.height}`,
    ...bandLines,
    `  estimatedContentRightEdgePercent=${metrics.estimatedContentRightEdgePercent.toFixed(2)} distanceFromImageRightEdgePercent=${metrics.distanceFromImageRightEdgePercent.toFixed(2)}`,
  ].join('\n');
}

async function runForMessage(messageId: string): Promise<void> {
  const queryResult = await pool.query<{ telegram_photo_file_id: string }>(
    'SELECT telegram_photo_file_id FROM telegram_messages WHERE id = $1',
    [messageId],
  );
  const row = queryResult.rows[0];
  if (!row) {
    console.error(`[mrz-right-edge-geometry] message=${messageId}: no telegram_messages row found`);
    return;
  }

  const { buffer } = await downloadTelegramPhoto(row.telegram_photo_file_id);
  const { width: imageWidth, height: imageHeight } = await getImageDimensions(buffer);
  const candidates = findMrzCandidateRegions(imageWidth, imageHeight);

  console.log(`\n[mrz-right-edge-geometry] ===== message=${messageId} =====`);
  console.log(`[mrz-right-edge-geometry] image=${imageWidth}x${imageHeight}`);
  console.log(
    '[mrz-right-edge-geometry] SUMMARY (PII-safe — no OCR text, MRZ values, or the image itself, only pixel statistics):',
  );

  for (const [candidateIndex, candidate] of candidates.entries()) {
    // Same extract() call shape cropRegion.ts itself uses — full image
    // width, no horizontal cropping — but raw grayscale, no normalize/
    // upscale/sharpen/binarize, since this measures the SOURCE photo's
    // own content, not an OCR-optimized version of it.
    const { data, info } = await sharp(buffer)
      .extract({ left: 0, top: candidate.top, width: imageWidth, height: candidate.height })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    console.log(`[mrz-right-edge-geometry] candidate=${candidateIndex} cropUsesFullImageWidth=${info.width === imageWidth}`);
    const metrics = computeRightEdgeGeometryMetrics(data, info.width, info.height);
    console.log(formatRightEdgeGeometryMetrics(candidateIndex, metrics));
  }
}

async function main(): Promise<void> {
  const messageIds = process.argv.slice(2);
  if (messageIds.length === 0) {
    console.error('Usage: tsx scripts/tmp-diagnostic-mrz-right-edge-geometry.ts <telegram_messages.id> [<telegram_messages.id> ...]');
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

if (process.argv[1] && process.argv[1].endsWith('tmp-diagnostic-mrz-right-edge-geometry.ts')) {
  main().catch((error) => {
    console.error('[mrz-right-edge-geometry] failed:', error instanceof Error ? error.message : 'unknown error');
    process.exitCode = 1;
  });
}
