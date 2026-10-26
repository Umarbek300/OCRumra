import { isRealCalendarDate } from '../ocr/passportExtractionSchema.js';

/**
 * VisitSaudi's "Expected Date of Arrival" is simply the group's own,
 * already-trustworthy departure date (groups.departureDate -- see
 * parseDepartureDateFromGroupTitle.ts for how that value itself is
 * validated at group-registration time). "Expected Date of Departure" is
 * that same date plus this many calendar days -- a fixed trip length, not
 * a value read from anywhere else.
 */
const RETURN_TRIP_LENGTH_DAYS = 14;

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface VisitSaudiTripDates {
  /** Same value as the input departure date, unchanged -- see this module's own doc comment. */
  arrivalDate: string;
  /** Input departure date plus RETURN_TRIP_LENGTH_DAYS calendar days. */
  departureFromSaudiDate: string;
}

export type ComputeVisitSaudiTripDatesResult =
  | { ok: true; dates: VisitSaudiTripDates }
  | { ok: false; reason: 'INVALID_DEPARTURE_DATE' };

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Adds `days` calendar days to an ISO (YYYY-MM-DD) date, entirely in UTC --
 * never via a locale/timezone-sensitive `new Date(isoString)` parse. Epoch-
 * millisecond arithmetic lets JS's own UTC date normalization handle every
 * month/year rollover (including leap-year February) correctly; the result
 * is read back out via UTC getters only, so the host machine's local
 * timezone can never shift the resulting calendar day. Mirrors the same
 * Date.UTC/getUTC* convention already used by
 * parseDepartureDateFromGroupTitle.ts and normalizeMrzDate.ts.
 */
function addDaysUtc(isoDate: string, days: number): string {
  const [yearStr, monthStr, dayStr] = isoDate.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  const resultMs = Date.UTC(year, month - 1, day) + days * 24 * 60 * 60 * 1000;
  const result = new Date(resultMs);
  return `${result.getUTCFullYear()}-${pad2(result.getUTCMonth() + 1)}-${pad2(result.getUTCDate())}`;
}

/**
 * Computes VisitSaudi's "Expected Date of Arrival" and "Expected Date of
 * Departure" from a group's departure date. Never guesses or silently
 * substitutes a nearby valid date for a malformed/impossible input (e.g.
 * "2026-02-30") -- returns `{ ok: false }` instead, so a caller can stop
 * and ask an operator rather than submit a wrong date to the real portal.
 */
export function computeVisitSaudiTripDates(groupDepartureDateIso: string): ComputeVisitSaudiTripDatesResult {
  if (!ISO_DATE_PATTERN.test(groupDepartureDateIso) || !isRealCalendarDate(groupDepartureDateIso)) {
    return { ok: false, reason: 'INVALID_DEPARTURE_DATE' };
  }

  return {
    ok: true,
    dates: {
      arrivalDate: groupDepartureDateIso,
      departureFromSaudiDate: addDaysUtc(groupDepartureDateIso, RETURN_TRIP_LENGTH_DAYS),
    },
  };
}
