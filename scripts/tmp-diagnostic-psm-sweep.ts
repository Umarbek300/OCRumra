/**
 * TEMPORARY ONE-OFF DIAGNOSTIC — not part of the production OCR pipeline.
 * Follow-up to tmp-diagnostic-split-crop-stats.ts: that diagnostic confirmed
 * message 270's candidate=0 TOP-half crop deterministically crashes the
 * real `tesseract` binary with SIGFPE at `--psm 7 --oem 1` (the exact
 * options splitLineOcr.ts uses), while the BOTTOM half — with very similar
 * pixel statistics — succeeds. This script takes that SAME TOP crop and
 * runs Tesseract against it at several different `--psm` values, ONE
 * PROCESS AT A TIME (never Promise.all — sequential, independent spawns),
 * to see whether the crash is specific to psm=7 or reproduces across
 * segmentation modes. Never logs OCR'd text — only exit code / signal /
 * outcome per variant. Read-only: no DB writes, no Redis, no temp files on
 * disk. No new dependency: uses node:child_process directly, the same way
 * runTesseractOcr.ts does — this is a separate, isolated implementation so
 * runTesseractOcr.ts itself stays untouched.
 */
import { spawn } from 'node:child_process';
import { cropRegion } from '../src/ocr/mrz/cropRegion.js';
import { findMrzCandidateRegions } from '../src/ocr/mrz/findMrzCandidateRegions.js';
import { getImageDimensions } from '../src/ocr/mrz/getImageDimensions.js';
import { pool } from '../src/db/pool.js';
import { downloadTelegramPhoto } from '../src/telegram/downloadTelegramPhoto.js';

const MRZ_CHAR_WHITELIST = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<';

export type TesseractVariantOutcome = 'succeeded' | 'crashed' | 'failed';

export interface TesseractVariantResult {
  psm: number;
  oem: number;
  exitCode: number | null;
  signal: string | null;
  outcome: TesseractVariantOutcome;
}

function classifyOutcome(code: number | null, signal: string | null): TesseractVariantOutcome {
  if (code === 0) return 'succeeded';
  if (signal) return 'crashed';
  return 'failed';
}

/**
 * Runs exactly one, independent Tesseract process for one (psm, oem)
 * combination — mirrors runTesseractOcr.ts's spawn/stdio-pipe approach
 * (including the MRZ whitelist, matching splitLineOcr.ts's real call
 * exactly), but returns the raw exit code/signal instead of throwing, and
 * never buffers/returns OCR'd text at all — this diagnostic only cares
 * about how the process exited.
 */
export function runTesseractVariant(
  imageBuffer: Buffer,
  psm: number,
  oem: number,
  binaryPath = 'tesseract',
): Promise<TesseractVariantResult> {
  const args = ['-', 'stdout', '--psm', String(psm), '--oem', String(oem), '-c', `tessedit_char_whitelist=${MRZ_CHAR_WHITELIST}`];

  return new Promise((resolve) => {
    const child = spawn(binaryPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });

    // Drain stdout/stderr without storing or logging any of it.
    child.stdout.on('data', () => {});
    child.stderr.on('data', () => {});

    child.on('error', () => {
      resolve({ psm, oem, exitCode: null, signal: null, outcome: 'failed' });
    });

    child.on('close', (code, signal) => {
      resolve({ psm, oem, exitCode: code, signal, outcome: classifyOutcome(code, signal) });
    });

    child.stdin.on('error', () => {
      // Same rationale as runTesseractOcr.ts: swallow EPIPE from an
      // already-dead process; 'close'/'error' above already handle it.
    });
    child.stdin.end(imageBuffer);
  });
}

export type RunTesseractVariantFn = typeof runTesseractVariant;

/**
 * Runs one Tesseract variant per PSM value, STRICTLY sequentially (awaited
 * in a for-loop, never Promise.all) — each process is independent and a
 * crash on one PSM never stops the sweep from trying the rest.
 */
export async function runPsmSweepDiagnostic(
  imageBuffer: Buffer,
  psmValues: readonly number[],
  oem: number,
  runVariant: RunTesseractVariantFn = runTesseractVariant,
): Promise<TesseractVariantResult[]> {
  const results: TesseractVariantResult[] = [];
  for (const psm of psmValues) {
    const result = await runVariant(imageBuffer, psm, oem);
    results.push(result);
  }
  return results;
}

export function formatPsmSweepResults(results: readonly TesseractVariantResult[]): string {
  return results
    .map((r) => `  psm=${r.psm} oem=${r.oem} exitCode=${r.exitCode ?? 'null'} signal=${r.signal ?? 'null'} outcome=${r.outcome}`)
    .join('\n');
}

export interface HalfRegion {
  top: number;
  height: number;
}

/**
 * Reproduces splitLineOcr.ts's exact top/bottom half split (same
 * halfHeight rounding, same boundaries) for a given candidate region —
 * pure geometry, no image content, so it's trivially testable without a
 * real image.
 */
export function computeHalfRegions(candidateTop: number, candidateHeight: number): { top: HalfRegion; bottom: HalfRegion } {
  const halfHeight = Math.max(1, Math.round(candidateHeight / 2));
  return {
    top: { top: candidateTop, height: halfHeight },
    bottom: { top: candidateTop + halfHeight, height: candidateHeight - halfHeight },
  };
}

export interface LabeledPsmResult extends TesseractVariantResult {
  message: string;
  half: 'TOP' | 'BOTTOM';
}

export interface MessageHalfSweepDependencies {
  cropRegion: typeof cropRegion;
  runVariant: RunTesseractVariantFn;
}

const defaultMessageHalfSweepDependencies: MessageHalfSweepDependencies = { cropRegion, runVariant: runTesseractVariant };

/**
 * Crops ONE half region once, then sweeps every PSM value against that same
 * crop, sequentially (via runPsmSweepDiagnostic — never Promise.all),
 * labeling every result with which message/half it came from.
 */
export async function runMessageHalfSweep(
  message: string,
  half: 'TOP' | 'BOTTOM',
  imageBuffer: Buffer,
  region: HalfRegion,
  psmValues: readonly number[],
  oem: number,
  deps: MessageHalfSweepDependencies = defaultMessageHalfSweepDependencies,
): Promise<LabeledPsmResult[]> {
  const crop = await deps.cropRegion(imageBuffer, region.top, region.height);
  const results = await runPsmSweepDiagnostic(crop, psmValues, oem, deps.runVariant);
  return results.map((result) => ({ ...result, message, half }));
}

/**
 * Groups labeled results under one "message=... half=..." header per
 * (message, half) group, in the order they were produced — never OCR'd
 * text, only the numeric/status fields already on LabeledPsmResult.
 */
export function formatLabeledResults(results: readonly LabeledPsmResult[]): string {
  const lines: string[] = [];
  let lastKey = '';
  for (const result of results) {
    const key = `${result.message}|${result.half}`;
    if (key !== lastKey) {
      lines.push(`message=${result.message} half=${result.half}`);
      lastKey = key;
    }
    lines.push(
      `  psm=${result.psm} oem=${result.oem} exitCode=${result.exitCode ?? 'null'} signal=${result.signal ?? 'null'} outcome=${result.outcome}`,
    );
  }
  return lines.join('\n');
}

const PSM_VALUES = [6, 7, 8, 13] as const;
const OEM = 1;

async function runSweepForMessage(messageId: string): Promise<LabeledPsmResult[]> {
  const queryResult = await pool.query<{ telegram_photo_file_id: string }>(
    'SELECT telegram_photo_file_id FROM telegram_messages WHERE id = $1',
    [messageId],
  );
  const row = queryResult.rows[0];
  if (!row) {
    console.error(`[psm-sweep] no telegram_messages row found for id=${messageId}`);
    return [];
  }

  const { buffer } = await downloadTelegramPhoto(row.telegram_photo_file_id);
  const { width, height } = await getImageDimensions(buffer);
  const candidates = findMrzCandidateRegions(width, height);
  const candidate0 = candidates[0];
  if (!candidate0) {
    console.error(`[psm-sweep] message=${messageId}: findMrzCandidateRegions returned no candidates`);
    return [];
  }

  const { top: topRegion, bottom: bottomRegion } = computeHalfRegions(candidate0.top, candidate0.height);

  console.log(
    `[psm-sweep] message=${messageId} image=${width}x${height} candidate0={top:${candidate0.top},height:${candidate0.height}} ` +
      `topHalf={top:${topRegion.top},height:${topRegion.height}} bottomHalf={top:${bottomRegion.top},height:${bottomRegion.height}}`,
  );

  // Sequential across halves too — TOP fully finishes (all 4 PSM values)
  // before BOTTOM starts. Never Promise.all.
  const topResults = await runMessageHalfSweep(messageId, 'TOP', buffer, topRegion, PSM_VALUES, OEM);
  const bottomResults = await runMessageHalfSweep(messageId, 'BOTTOM', buffer, bottomRegion, PSM_VALUES, OEM);

  return [...topResults, ...bottomResults];
}

async function main(): Promise<void> {
  const messageIds = process.argv.slice(2);
  if (messageIds.length === 0) {
    console.error('Usage: tsx scripts/tmp-diagnostic-psm-sweep.ts <telegram_messages.id> [<telegram_messages.id> ...]');
    process.exitCode = 1;
    return;
  }

  try {
    const allResults: LabeledPsmResult[] = [];
    // Sequential across messages too, for the same reason: one bounded,
    // independent Tesseract process at a time, never Promise.all.
    for (const messageId of messageIds) {
      const results = await runSweepForMessage(messageId);
      allResults.push(...results);
    }

    console.log('\n[psm-sweep] SUMMARY (PII-safe — no OCR text, exit status only):\n');
    console.log(formatLabeledResults(allResults));
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && process.argv[1].endsWith('tmp-diagnostic-psm-sweep.ts')) {
  main().catch((error) => {
    console.error('[psm-sweep] failed:', error instanceof Error ? error.message : 'unknown error');
    process.exitCode = 1;
  });
}
