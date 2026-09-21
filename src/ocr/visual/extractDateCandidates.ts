import { isRealCalendarDate } from '../passportExtractionSchema.js';

const MONTH_ABBREVIATIONS: Record<string, string> = {
  JAN: '01',
  FEB: '02',
  MAR: '03',
  APR: '04',
  MAY: '05',
  JUN: '06',
  JUL: '07',
  AUG: '08',
  SEP: '09',
  OCT: '10',
  NOV: '11',
  DEC: '12',
};

// Passport visual zones are printed, not handwritten, so a plausible-year
// guard is enough to reject stray digit runs without needing OCR-specific
// tuning; the actual calendar validity check is isRealCalendarDate.
const MIN_PLAUSIBLE_YEAR = 1900;
const MAX_PLAUSIBLE_YEAR = 2099;

const TEXTUAL_MONTH_PATTERN = /(\d{2})\s?(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\s?(\d{4})/g;
const NUMERIC_DATE_PATTERN = /(\d{2})[./-](\d{2})[./-](\d{4})/g;
const ISO_DATE_PATTERN = /(\d{4})-(\d{2})-(\d{2})/g;

function pad2(value: string): string {
  return value.padStart(2, '0');
}

function isPlausibleYear(year: number): boolean {
  return year >= MIN_PLAUSIBLE_YEAR && year <= MAX_PLAUSIBLE_YEAR;
}

function addIfValid(found: Set<string>, year: string, month: string, day: string): void {
  const iso = `${year}-${pad2(month)}-${pad2(day)}`;
  if (isPlausibleYear(Number(year)) && isRealCalendarDate(iso)) {
    found.add(iso);
  }
}

/**
 * Recognizes date-shaped text in free-form (non-MRZ) OCR output and
 * normalizes each to ISO (YYYY-MM-DD). Never repairs or guesses an
 * impossible date — an invalid calendar date or implausible year is simply
 * dropped rather than corrected.
 */
export function extractDateCandidates(text: string): string[] {
  const found = new Set<string>();

  for (const match of text.matchAll(TEXTUAL_MONTH_PATTERN)) {
    const [, day, monthName, year] = match;
    addIfValid(found, year!, MONTH_ABBREVIATIONS[monthName!]!, day!);
  }

  for (const match of text.matchAll(NUMERIC_DATE_PATTERN)) {
    const [, day, month, year] = match;
    addIfValid(found, year!, month!, day!);
  }

  for (const match of text.matchAll(ISO_DATE_PATTERN)) {
    const [, year, month, day] = match;
    addIfValid(found, year!, month!, day!);
  }

  return [...found];
}
