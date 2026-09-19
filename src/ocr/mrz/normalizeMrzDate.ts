import { isRealCalendarDate } from '../passportExtractionSchema.js';

/**
 * MRZ dates are YYMMDD with no century — ICAO 9303 leaves resolving the
 * century to the application, it is not encoded anywhere in the MRZ. This
 * is standard, required interpretation logic, not guessed content: a
 * two-digit year has exactly one sensible real-world reading once you know
 * whether the field is a birth date (must not be in the future) or an
 * expiry date (a travel document is never valid for anywhere near 100
 * years, so the far reading is never the intended one).
 */
function resolveTwoDigitYear(twoDigitYear: number, kind: 'birth' | 'expiry', now: Date): number {
  const currentYear = now.getUTCFullYear();
  const currentCentury = Math.floor(currentYear / 100) * 100;
  let candidate = currentCentury + twoDigitYear;

  if (kind === 'birth') {
    if (candidate > currentYear) candidate -= 100;
    return candidate;
  }

  // expiry: prefer whichever century reading is closer to "now" — no
  // passport is issued with a 50+ year validity window.
  if (candidate < currentYear - 20) candidate += 100;
  else if (candidate > currentYear + 20) candidate -= 100;
  return candidate;
}

/**
 * Converts a raw 6-digit MRZ date (YYMMDD) to YYYY-MM-DD, or null if the
 * input isn't a well-formed 6-digit date or doesn't resolve to a real
 * calendar date (never invents a date to fill the gap).
 */
export function normalizeMrzDate(rawYyMmDd: string | null | undefined, kind: 'birth' | 'expiry', now: Date = new Date()): string | null {
  if (!rawYyMmDd || !/^\d{6}$/.test(rawYyMmDd)) return null;

  const yy = Number(rawYyMmDd.slice(0, 2));
  const mm = rawYyMmDd.slice(2, 4);
  const dd = rawYyMmDd.slice(4, 6);
  const year = resolveTwoDigitYear(yy, kind, now);
  const iso = `${String(year).padStart(4, '0')}-${mm}-${dd}`;

  return isRealCalendarDate(iso) ? iso : null;
}
