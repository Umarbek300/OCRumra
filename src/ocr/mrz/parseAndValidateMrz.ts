import { parse as parseMrzLines, type ParseResult } from 'mrz';

/**
 * Thin wrapper around the `mrz` package: parses raw OCR'd MRZ text lines,
 * validates every check digit, and applies the package's own autocorrect
 * for common OCR confusions (e.g. O/0, I/1) in positions where only one
 * reading is structurally valid. Never invents a value — autocorrect only
 * ever resolves an already-present character to the one the checksum/format
 * requires, it doesn't fill in missing data.
 *
 * Returns null (never throws) when the input isn't a recognizable MRZ shape
 * at all — e.g. OCR produced lines of the wrong length. That's a real,
 * expected outcome for a bad photo, not a bug, so callers treat it as
 * "invalid / low confidence", never crash the worker.
 */
export function parseAndValidateMrz(rawLines: readonly string[]): ParseResult | null {
  try {
    return parseMrzLines(rawLines, { autocorrect: true });
  } catch {
    return null;
  }
}

export type { ParseResult, FieldName, Details } from 'mrz';
