import { TD3_MRZ_LINE_LENGTH } from './normalizeMrzLine.js';

const MRZ_LINE_PATTERN = /^[A-Z0-9<]+$/;

/**
 * Cheap structural pre-check — never inspects meaning, only shape: exact
 * expected length and restricted MRZ alphabet only. Filler ('<') is allowed
 * but not required because valid TD3 lines can contain no filler characters.
 * Used to decide whether a candidate OCR line is worth fully validating,
 * without ever reasoning about or logging the actual content.
 */
export function looksLikeMrzLine(line: string, expectedLength: number = TD3_MRZ_LINE_LENGTH): boolean {
  return line.length === expectedLength && MRZ_LINE_PATTERN.test(line);
}
