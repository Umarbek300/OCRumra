import { TD3_MRZ_LINE_LENGTH } from './normalizeMrzLine.js';

const MRZ_LINE_PATTERN = /^[A-Z0-9<]+$/;

/**
 * Cheap structural pre-check — never inspects meaning, only shape: exact
 * expected length, restricted MRZ alphabet only, and at least one filler
 * ('<') character (every real MRZ line has some padding). Used to decide
 * whether a candidate crop/OCR attempt is worth fully validating, without
 * ever reasoning about or logging the actual content.
 */
export function looksLikeMrzLine(line: string, expectedLength: number = TD3_MRZ_LINE_LENGTH): boolean {
  return line.length === expectedLength && MRZ_LINE_PATTERN.test(line) && line.includes('<');
}
