/**
 * TEMPORARY ONE-OFF DIAGNOSTIC — not part of the production OCR pipeline.
 * Investigates a real production SIGFPE crash observed inside the Tesseract
 * binary during the `fallback-split` stage (see splitLineOcr.ts) for a real
 * passport photo's candidate=0 region. Reproduces the EXACT same top/bottom
 * half crop split splitLineOcr.ts uses (same cropRegion call, same default
 * options — no binarize, default scale=2), reports only structural pixel
 * statistics (dimensions, mean/stdev/min/max, a rough non-background pixel
 * ratio) for each half, and runs Tesseract on each half SEPARATELY (not in
 * Promise.all, unlike production) so one half crashing never hides whether
 * the other half also crashes. Never logs OCR'd text or any MRZ/passport
 * content — structural facts only. Read-only: no DB writes, no Redis, no
 * temp files written to disk (everything stays in memory as Buffers).
 */
import sharp from 'sharp';
import { cropRegion } from '../src/ocr/mrz/cropRegion.js';
import { runTesseractOcr } from '../src/ocr/mrz/runTesseractOcr.js';
import { findMrzCandidateRegions } from '../src/ocr/mrz/findMrzCandidateRegions.js';
import { getImageDimensions } from '../src/ocr/mrz/getImageDimensions.js';
import { pool } from '../src/db/pool.js';
import { downloadTelegramPhoto } from '../src/telegram/downloadTelegramPhoto.js';

export interface CropStats {
  width: number;
  height: number;
  mean: number;
  stdev: number;
  min: number;
  max: number;
  /**
   * Rough proxy for "how much of this crop looks like actual content vs. a
   * flat background": the fraction of pixels more than one stdev away from
   * the mean. A near-blank/degenerate image (stdev ~ 0) will have this at
   * or near 0 by construction. Not a precise ink-detection metric — a
   * structural sanity signal only.
   */
  nonBackgroundRatio: number;
}

export async function computeCropStats(imageBuffer: Buffer): Promise<CropStats> {
  const image = sharp(imageBuffer).grayscale();
  const { width, height } = await image.metadata();
  const stats = await image.stats();
  const channel = stats.channels[0];
  if (!width || !height || !channel) {
    throw new Error('Could not compute crop stats: missing image dimensions or channel data');
  }

  const { data } = await sharp(imageBuffer).grayscale().raw().toBuffer({ resolveWithObject: true });
  const mean = channel.mean;
  const stdev = channel.stdev;
  let nonBackgroundCount = 0;
  for (const value of data) {
    if (Math.abs(value - mean) > stdev) nonBackgroundCount += 1;
  }

  return {
    width,
    height,
    mean,
    stdev,
    min: channel.min,
    max: channel.max,
    nonBackgroundRatio: data.length > 0 ? nonBackgroundCount / data.length : 0,
  };
}

export type TesseractOutcome = 'succeeded' | 'crashed' | 'failed';

export interface HalfDiagnosticResult {
  top: number;
  height: number;
  stats: CropStats;
  tesseractOutcome: TesseractOutcome;
  /** The signal name (e.g. "SIGFPE"), only when the process was terminated by a signal. */
  crashSignal: string | null;
  /** Present only for a non-crash failure (e.g. a normal non-zero exit) — never OCR'd text. */
  failureReason: string | null;
}

export interface SplitCropDiagnosticResult {
  top: HalfDiagnosticResult;
  bottom: HalfDiagnosticResult;
}

export interface SplitCropDiagnosticDependencies {
  cropRegion: typeof cropRegion;
  runTesseractOcr: typeof runTesseractOcr;
}

const defaultDependencies: SplitCropDiagnosticDependencies = { cropRegion, runTesseractOcr };

function classifyError(error: unknown): { outcome: TesseractOutcome; crashSignal: string | null; failureReason: string | null } {
  const message = error instanceof Error ? error.message : 'unknown error';
  const signalMatch = /terminated by signal (\w+)/.exec(message);
  if (signalMatch?.[1]) {
    return { outcome: 'crashed', crashSignal: signalMatch[1], failureReason: null };
  }
  return { outcome: 'failed', crashSignal: null, failureReason: message };
}

async function diagnoseHalf(
  imageBuffer: Buffer,
  top: number,
  height: number,
  deps: SplitCropDiagnosticDependencies,
): Promise<HalfDiagnosticResult> {
  const crop = await deps.cropRegion(imageBuffer, top, height);
  const stats = await computeCropStats(crop);

  try {
    // Single-line PSM (7) + LSTM (oem 1), matching splitLineOcr.ts exactly.
    await deps.runTesseractOcr(crop, { psm: 7, oem: 1 });
    return { top, height, stats, tesseractOutcome: 'succeeded', crashSignal: null, failureReason: null };
  } catch (error) {
    const { outcome, crashSignal, failureReason } = classifyError(error);
    return { top, height, stats, tesseractOutcome: outcome, crashSignal, failureReason };
  }
}

/**
 * Reproduces splitLineOcr.ts's exact top/bottom half split (same halfHeight
 * rounding, same crop boundaries), but runs Tesseract on each half
 * SEPARATELY and sequentially — production runs both in Promise.all, which
 * means if one half crashes the process, we can't tell from production
 * logs alone whether the other half would have crashed too. This isolates
 * each half's outcome independently.
 */
export async function runSplitCropDiagnostic(
  imageBuffer: Buffer,
  top: number,
  height: number,
  deps: SplitCropDiagnosticDependencies = defaultDependencies,
): Promise<SplitCropDiagnosticResult> {
  const halfHeight = Math.max(1, Math.round(height / 2));

  const topResult = await diagnoseHalf(imageBuffer, top, halfHeight, deps);
  const bottomResult = await diagnoseHalf(imageBuffer, top + halfHeight, height - halfHeight, deps);

  return { top: topResult, bottom: bottomResult };
}

function formatHalf(label: string, half: HalfDiagnosticResult): string {
  return [
    `  ${label}: top=${half.top} height=${half.height}`,
    `    stats: width=${half.stats.width} height=${half.stats.height} mean=${half.stats.mean.toFixed(2)} stdev=${half.stats.stdev.toFixed(2)} min=${half.stats.min} max=${half.stats.max} nonBackgroundRatio=${half.stats.nonBackgroundRatio.toFixed(4)}`,
    `    tesseractOutcome=${half.tesseractOutcome} crashSignal=${half.crashSignal ?? 'null'} failureReason=${half.failureReason ?? 'null'}`,
  ].join('\n');
}

export function formatSplitCropDiagnosticResult(result: SplitCropDiagnosticResult): string {
  return [formatHalf('TOP half', result.top), formatHalf('BOTTOM half', result.bottom)].join('\n');
}

async function main(): Promise<void> {
  const messageId = process.argv[2];
  if (!messageId) {
    console.error('Usage: tsx scripts/tmp-diagnostic-split-crop-stats.ts <telegram_messages.id>');
    process.exitCode = 1;
    return;
  }

  try {
    const queryResult = await pool.query<{ telegram_photo_file_id: string }>(
      'SELECT telegram_photo_file_id FROM telegram_messages WHERE id = $1',
      [messageId],
    );
    const row = queryResult.rows[0];
    if (!row) {
      console.error(`[split-crop-stats] no telegram_messages row found for id=${messageId}`);
      process.exitCode = 1;
      return;
    }

    const { buffer } = await downloadTelegramPhoto(row.telegram_photo_file_id);
    const { width, height } = await getImageDimensions(buffer);
    const candidates = findMrzCandidateRegions(width, height);
    const candidate0 = candidates[0];
    if (!candidate0) {
      console.error('[split-crop-stats] findMrzCandidateRegions returned no candidates');
      process.exitCode = 1;
      return;
    }

    console.log(
      `[split-crop-stats] image=${width}x${height} candidate0={top:${candidate0.top},height:${candidate0.height}}`,
    );

    const result = await runSplitCropDiagnostic(buffer, candidate0.top, candidate0.height);

    console.log('\n[split-crop-stats] SUMMARY (PII-safe — structural stats only, no OCR text):\n');
    console.log(formatSplitCropDiagnosticResult(result));
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && process.argv[1].endsWith('tmp-diagnostic-split-crop-stats.ts')) {
  main().catch((error) => {
    console.error('[split-crop-stats] failed:', error instanceof Error ? error.message : 'unknown error');
    process.exitCode = 1;
  });
}
