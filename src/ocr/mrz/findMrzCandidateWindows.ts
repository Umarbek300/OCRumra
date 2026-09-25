import { looksLikeMrzLine } from './looksLikeMrzLine.js';
import { normalizeMrzLineLength } from './normalizeMrzLine.js';

// Real TD3 MRZ lines are always 44 characters, but an OCR read can be off
// by one or two (a dropped/duplicated trailing filler char) — this window
// is deliberately generous so a near-miss still reaches full checksum
// validation, instead of being discarded purely on length. It only needs
// to be tight enough to exclude obviously non-MRZ text (short words, page
// headers).
const MIN_CANDIDATE_LENGTH = 30;
const MAX_CANDIDATE_LENGTH = 50;
const MRZ_ALPHABET_PATTERN = /^[A-Z0-9<]+$/;

/**
 * Looser than looksLikeMrzLine (which requires the exact 44-char TD3
 * length): only filters out lines that clearly aren't MRZ-shaped at all
 * (wrong alphabet, or far too short/long), so a window with a realistic
 * OCR length miss isn't discarded before checksum validation ever sees
 * it. Deliberately does not require a filler ('<') character — a valid
 * TD3 line can legitimately contain none (see looksLikeMrzLine.ts).
 */
function looksApproximatelyLikeMrzLine(line: string): boolean {
  return line.length >= MIN_CANDIDATE_LENGTH && line.length <= MAX_CANDIDATE_LENGTH && MRZ_ALPHABET_PATTERN.test(line);
}

export interface MrzCandidateWindowMeta {
  windowIndex: number;
  rawLengths: [number, number];
  normalizedLengths: [number, number];
  looksLikeMrz: [boolean, boolean];
}

export interface MrzCandidateWindow {
  lines: [string, string];
  window: MrzCandidateWindowMeta;
}

/**
 * Splits a full page of OCR'd text into cleaned lines, then finds every
 * consecutive 2-line window that's plausibly MRZ-shaped. Each window's
 * lines are normalized (via the existing, unmodified
 * normalizeMrzLineLength) before being returned — the caller is
 * responsible for actual checksum validation. looksLikeMrz is recorded
 * per line as a structural signal but never used to reject a window
 * outright here. Never logs or returns anything beyond line content
 * itself (no separate content-bearing field) and structural metadata.
 */
export function findMrzCandidateWindows(fullText: string): MrzCandidateWindow[] {
  const cleanedLines = fullText
    .split('\n')
    .map((line) => line.replace(/\s+/g, '').toUpperCase())
    .filter((line) => line.length > 0);

  const windows: MrzCandidateWindow[] = [];
  for (let i = 0; i < cleanedLines.length - 1; i++) {
    const rawA = cleanedLines[i]!;
    const rawB = cleanedLines[i + 1]!;
    if (!looksApproximatelyLikeMrzLine(rawA) || !looksApproximatelyLikeMrzLine(rawB)) continue;

    const normalizedA = normalizeMrzLineLength(rawA);
    const normalizedB = normalizeMrzLineLength(rawB);

    windows.push({
      lines: [normalizedA, normalizedB],
      window: {
        windowIndex: i,
        rawLengths: [rawA.length, rawB.length],
        normalizedLengths: [normalizedA.length, normalizedB.length],
        looksLikeMrz: [looksLikeMrzLine(normalizedA), looksLikeMrzLine(normalizedB)],
      },
    });
  }
  return windows;
}
