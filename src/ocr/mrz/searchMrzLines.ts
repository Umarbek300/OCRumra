import { cropRegion } from './cropRegion.js';
import { extractMrzLines } from './extractMrzLines.js';
import { findMrzCandidateRegions } from './findMrzCandidateRegions.js';
import { getImageDimensions } from './getImageDimensions.js';
import { looksLikeMrzLine } from './looksLikeMrzLine.js';
import { parseAndValidateMrz, type ParseResult } from './parseAndValidateMrz.js';
import { runTesseractOcr } from './runTesseractOcr.js';

export interface SearchMrzLinesDependencies {
  cropRegion: typeof cropRegion;
  runTesseractOcr: typeof runTesseractOcr;
}

const defaultDependencies: SearchMrzLinesDependencies = {
  cropRegion,
  runTesseractOcr,
};

export interface MrzSearchResult {
  lines: string[];
  parsed: ParseResult;
}

/**
 * Searches a small, bounded set of candidate crop regions (see
 * findMrzCandidateRegions) for a genuine, checksum-parseable MRZ block —
 * this is the primary strategy now, replacing a single fixed-percentage
 * crop, which production evidence showed is not reliable across photos
 * taken at different distances/framing.
 *
 * For each candidate: crop + enhance -> OCR (block mode) -> clean/trim ->
 * structural shape check -> only if that passes, attempt full check-digit
 * validation. Stops at the first candidate that produces a genuinely
 * parseable MRZ. Returns null (never throws, never guesses) if no
 * candidate works — callers fall through to the original fixed-crop
 * fallback. Never logs OCR'd text, only geometry/lengths/counts.
 */
export async function searchMrzLines(
  imageBuffer: Buffer,
  deps: SearchMrzLinesDependencies = defaultDependencies,
): Promise<MrzSearchResult | null> {
  const { width, height } = await getImageDimensions(imageBuffer);
  const candidates = findMrzCandidateRegions(width, height);

  for (const [index, candidate] of candidates.entries()) {
    const cropped = await deps.cropRegion(imageBuffer, candidate.top, candidate.height);
    const rawText = await deps.runTesseractOcr(cropped, { psm: 6, oem: 1 });
    const lines = extractMrzLines(rawText);

    console.log(
      `[mrz-search] candidate=${index} region=${width}x${candidate.height} lineCount=${lines.length} lengths=[${lines.map((line) => line.length).join(',')}]`,
    );

    if (lines.length !== 2 || !lines.every((line) => looksLikeMrzLine(line))) {
      continue;
    }

    const parsed = parseAndValidateMrz(lines);
    if (parsed) {
      return { lines, parsed };
    }
  }

  return null;
}
