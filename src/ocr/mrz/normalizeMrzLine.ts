const MRZ_FILLER_CHAR = '<';
export const TD3_MRZ_LINE_LENGTH = 44;

/**
 * Trims excess trailing filler ('<') characters down to the expected TD3
 * line length (44). MRZ lines are always padded to a fixed width with '<'
 * — it carries no data, it's pure padding — so when OCR reads one or two
 * extra trailing filler characters (a common artifact: the crop's bottom
 * edge or a sub-pixel upscaling artifact gets misread as an extra '<'),
 * trimming it is safe: it can only ever remove padding, never a real field.
 *
 * Deliberately conservative: only trims when the *excess* characters are
 * themselves trailing '<'. If a line is too long for some other reason
 * (a genuine misread elsewhere), this leaves it untouched — the line then
 * correctly fails MRZ validation and falls through to the existing
 * "unreadable" low-confidence result, rather than guessing which
 * character to drop and risking silently corrupting a real field.
 */
export function normalizeMrzLineLength(line: string, expectedLength: number = TD3_MRZ_LINE_LENGTH): string {
  let normalized = line;
  while (normalized.length > expectedLength && normalized.endsWith(MRZ_FILLER_CHAR)) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}
