/**
 * Cleans raw Tesseract stdout into candidate MRZ lines: strips stray
 * whitespace Tesseract sometimes inserts within a line (MRZ has none),
 * drops blank lines, and keeps only the last 2 non-blank lines — a TD3
 * passport MRZ is always exactly 2 lines, and Tesseract occasionally emits
 * a stray blank/partial line before the real MRZ block.
 */
export function extractMrzLines(rawOcrText: string): string[] {
  const lines = rawOcrText
    .split('\n')
    .map((line) => line.replace(/\s+/g, '').toUpperCase())
    .filter((line) => line.length > 0);

  return lines.slice(-2);
}
