import type { MrzCandidateWindow } from './findMrzCandidateWindows.js';
import { parseAndValidateMrz, type ParseResult } from './parseAndValidateMrz.js';

export interface MrzCandidateWinner {
  lines: [string, string];
  windowIndex: number;
  parsed: ParseResult;
}

export interface MrzCandidateSelection {
  /** First window whose checksum(s) genuinely validate (parsed.valid === true). Scanning stops here. */
  validWinner: MrzCandidateWinner | null;
  /**
   * First window that at least reached a structurally recognizable MRZ
   * parse (parsed !== null), regardless of checksum validity — tracked
   * independently of validWinner so a caller can see it even when no
   * window ever validates. Whether to ever use this as a final result
   * (a low-confidence fallback) is a separate policy decision this
   * function deliberately does not make.
   */
  firstStructuralMatch: MrzCandidateWinner | null;
}

/**
 * Scans candidate MRZ line-pair windows in order, calling the existing,
 * unmodified parseAndValidateMrz() on each. Tracks the first genuinely
 * checksum-valid match (stops scanning there, mirroring the existing
 * Tesseract search pipeline's "stop at first success" pattern) and,
 * independently, the first match that was merely structurally
 * recognizable regardless of checksum validity — never conflates the two.
 * Pure and read-only: no I/O, no logging, never touches OCR text or MRZ
 * field values beyond passing the already-cleaned line strings through
 * unchanged.
 */
export function selectMrzCandidateWinner(windows: readonly MrzCandidateWindow[]): MrzCandidateSelection {
  let validWinner: MrzCandidateWinner | null = null;
  let firstStructuralMatch: MrzCandidateWinner | null = null;

  for (const { lines, window } of windows) {
    const parsed = parseAndValidateMrz(lines);
    if (!parsed) continue;

    if (!firstStructuralMatch) {
      firstStructuralMatch = { lines, windowIndex: window.windowIndex, parsed };
    }

    if (parsed.valid) {
      validWinner = { lines, windowIndex: window.windowIndex, parsed };
      break;
    }
  }

  return { validWinner, firstStructuralMatch };
}
