/**
 * TEMPORARY ONE-OFF DIAGNOSTIC — not part of the production OCR pipeline.
 * Answers one narrow question raised while root-causing why real OCR
 * outputs shorter than 44 characters (e.g. length 40 or 43) fail
 * parseAndValidateMrz(): is the character deficit concentrated in the
 * trailing '<' filler run (Tesseract simply under-reading padding it
 * already partially recognized) or somewhere else in the line (a crop/
 * geometry issue cutting into real content)? Also cross-checks a second,
 * related hypothesis surfaced by a parallel Google Vision diagnostic: for
 * these same real photos, Vision's own raw text shows a well-formed
 * 44-character TD3 line 2 that contains *zero* '<' filler characters
 * (plausible when the optional personal-number field is fully used) —
 * which the production `looksLikeMrzLine()` (imported here unmodified,
 * never reimplemented) used to always reject via a `line.includes('<')`
 * requirement, since removed for exactly this reason. This script calls
 * that same real function against the real Tesseract-read lines to
 * confirm or rule out whether the equivalent shape also occurs on the
 * Tesseract side. Reuses the EXISTING,
 * unmodified production building blocks (findMrzCandidateRegions,
 * cropRegion, runTesseractOcr, extractMrzLines, splitLineOcr,
 * looksLikeMrzLine) exactly the way searchMrzLines.ts and localProvider.ts
 * already call them — this script does not modify or wrap those files, it
 * only computes shape metrics on top of their unmodified output.
 * Read-only: no DB writes, no Redis, no worker/bot involvement. Never
 * logs OCR'd text or any MRZ field value — only per-line counts and
 * booleans.
 */
import { cropRegion } from '../src/ocr/mrz/cropRegion.js';
import { extractMrzLines } from '../src/ocr/mrz/extractMrzLines.js';
import { findMrzCandidateRegions } from '../src/ocr/mrz/findMrzCandidateRegions.js';
import { getImageDimensions } from '../src/ocr/mrz/getImageDimensions.js';
import { looksLikeMrzLine } from '../src/ocr/mrz/looksLikeMrzLine.js';
import { runTesseractOcr } from '../src/ocr/mrz/runTesseractOcr.js';
import { splitLineOcr } from '../src/ocr/mrz/splitLineOcr.js';
import { pool } from '../src/db/pool.js';
import { downloadTelegramPhoto } from '../src/telegram/downloadTelegramPhoto.js';

const MRZ_FILLER_CHAR = '<';
const MRZ_ALPHABET_CHAR_PATTERN = /[A-Z0-9<]/;
const MRZ_ALPHABET_LINE_PATTERN = /^[A-Z0-9<]+$/;

const TD3_LINE_LENGTH = 44;

export interface MrzLineShapeMetrics {
  length: number;
  trailingFillerCount: number;
  leadingFillerCount: number;
  fillerCharCount: number;
  hasFillerChar: boolean;
  nonMrzAlphabetCharCount: number;
  matchesMrzAlphabet: boolean;
  looksLikeMrzLineResult: boolean;
  missingFromTd3Length: number;
  /**
   * Indices (0-based) where the literal '<' filler character occurs. Safe
   * to log: '<' is MRZ's own structural padding character, never a
   * document value, so its positions reveal line *shape* (e.g. the
   * standard single filler after the document-type letter, the double
   * filler between surname/given names, then a long trailing pad run) —
   * never a name, number, or date.
   */
  fillerPositions: number[];
}

/**
 * Structural shape of one OCR'd MRZ line — never the line content itself.
 * trailingFillerCount/leadingFillerCount/fillerCharCount count only the
 * literal '<' character (MRZ's own padding character, not a document
 * value); nonMrzAlphabetCharCount counts characters outside A-Z0-9<
 * (should normally be 0, since runTesseractOcr already whitelists this
 * alphabet — a nonzero count here is itself a diagnostic signal, not
 * content). looksLikeMrzLineResult calls the real, unmodified production
 * looksLikeMrzLine() so this script never reimplements or drifts from its
 * actual current behavior.
 */
export function computeMrzLineShapeMetrics(line: string): MrzLineShapeMetrics {
  let trailingFillerCount = 0;
  while (trailingFillerCount < line.length && line[line.length - 1 - trailingFillerCount] === MRZ_FILLER_CHAR) {
    trailingFillerCount++;
  }
  let leadingFillerCount = 0;
  while (leadingFillerCount < line.length && line[leadingFillerCount] === MRZ_FILLER_CHAR) {
    leadingFillerCount++;
  }
  let fillerCharCount = 0;
  let nonMrzAlphabetCharCount = 0;
  const fillerPositions: number[] = [];
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === MRZ_FILLER_CHAR) {
      fillerCharCount++;
      fillerPositions.push(i);
    }
    if (!MRZ_ALPHABET_CHAR_PATTERN.test(ch)) nonMrzAlphabetCharCount++;
  }
  return {
    length: line.length,
    trailingFillerCount,
    leadingFillerCount,
    fillerCharCount,
    hasFillerChar: fillerCharCount > 0,
    nonMrzAlphabetCharCount,
    matchesMrzAlphabet: line.length > 0 && MRZ_ALPHABET_LINE_PATTERN.test(line),
    looksLikeMrzLineResult: looksLikeMrzLine(line),
    missingFromTd3Length: Math.max(0, TD3_LINE_LENGTH - line.length),
    fillerPositions,
  };
}

export function formatMrzLineShapeMetrics(metrics: MrzLineShapeMetrics): string {
  return [
    `length=${metrics.length}`,
    `missingFromTd3Length=${metrics.missingFromTd3Length}`,
    `hasFillerChar=${metrics.hasFillerChar}`,
    `fillerCharCount=${metrics.fillerCharCount}`,
    `trailingFillerCount=${metrics.trailingFillerCount}`,
    `leadingFillerCount=${metrics.leadingFillerCount}`,
    `matchesMrzAlphabet=${metrics.matchesMrzAlphabet}`,
    `nonMrzAlphabetCharCount=${metrics.nonMrzAlphabetCharCount}`,
    `looksLikeMrzLineResult=${metrics.looksLikeMrzLineResult}`,
    `fillerPositions=[${metrics.fillerPositions.join(',')}]`,
  ].join(' ');
}

async function runForMessage(messageId: string): Promise<void> {
  const queryResult = await pool.query<{ telegram_photo_file_id: string }>(
    'SELECT telegram_photo_file_id FROM telegram_messages WHERE id = $1',
    [messageId],
  );
  const row = queryResult.rows[0];
  if (!row) {
    console.error(`[mrz-line-shape] message=${messageId}: no telegram_messages row found`);
    return;
  }

  const { buffer } = await downloadTelegramPhoto(row.telegram_photo_file_id);
  const { width, height } = await getImageDimensions(buffer);
  const candidates = findMrzCandidateRegions(width, height);

  console.log(`\n[mrz-line-shape] ===== message=${messageId} =====`);
  console.log(`[mrz-line-shape] image=${width}x${height}`);
  console.log('[mrz-line-shape] SUMMARY (PII-safe — no OCR text, MRZ values, or credentials, only per-line counts):');

  for (const [candidateIndex, candidate] of candidates.entries()) {
    // Same call shape as searchMrzLines.ts's "search" stage.
    const cropped = await cropRegion(buffer, candidate.top, candidate.height);
    const rawText = await runTesseractOcr(cropped, { psm: 6, oem: 1 });
    const searchLines = extractMrzLines(rawText);
    console.log(`[mrz-line-shape] candidate=${candidateIndex} stage=search`);
    searchLines.forEach((line, lineIndex) => {
      console.log(`  line${lineIndex}: ${formatMrzLineShapeMetrics(computeMrzLineShapeMetrics(line))}`);
    });

    // Same call shape as localProvider.ts's "fallback-split" stage.
    const splitLines = await splitLineOcr(buffer, candidate.top, candidate.height, { cropRegion, runTesseractOcr });
    console.log(`[mrz-line-shape] candidate=${candidateIndex} stage=split`);
    splitLines.forEach((line, lineIndex) => {
      console.log(`  line${lineIndex}: ${formatMrzLineShapeMetrics(computeMrzLineShapeMetrics(line))}`);
    });
  }
}

async function main(): Promise<void> {
  const messageIds = process.argv.slice(2);
  if (messageIds.length === 0) {
    console.error('Usage: tsx scripts/tmp-diagnostic-mrz-line-shape.ts <telegram_messages.id> [<telegram_messages.id> ...]');
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

if (process.argv[1] && process.argv[1].endsWith('tmp-diagnostic-mrz-line-shape.ts')) {
  main().catch((error) => {
    console.error('[mrz-line-shape] failed:', error instanceof Error ? error.message : 'unknown error');
    process.exitCode = 1;
  });
}
