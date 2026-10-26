import { isRealCalendarDate } from '../ocr/passportExtractionSchema.js';

/** VisitSaudi's own binary rule: strictly under this age -> SINGLE, at or above it -> MARRIED. */
const MARITAL_STATUS_AGE_THRESHOLD = 20;

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type MaritalStatusForVisitSaudi = 'SINGLE' | 'MARRIED';

export type ComputeMaritalStatusForVisitSaudiResult =
  | { ok: true; maritalStatus: MaritalStatusForVisitSaudi }
  | { ok: false; reason: 'INVALID_DATE_OF_BIRTH' | 'INVALID_DEPARTURE_DATE' };

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

interface IsoDateParts {
  year: number;
  month: number;
  day: number;
}

function parseIsoDateParts(isoDate: string): IsoDateParts {
  const [yearStr, monthStr, dayStr] = isoDate.split('-');
  return { year: Number(yearStr), month: Number(monthStr), day: Number(dayStr) };
}

/**
 * Exact age in whole years as of `referenceDate` -- the standard
 * "has this year's birthday already happened" algorithm, with one
 * explicit special case: a February 29 birth date, evaluated against a
 * reference year that is NOT itself a leap year, treats March 1 as the
 * effective birthday for the "has it happened yet" comparison (so Feb 28
 * of a non-leap reference year is "not yet", March 1 onward is "already
 * happened") -- this is a deliberate business rule (explicitly specified,
 * not left to guess which of the two equally-defensible conventions for a
 * missing Feb 29 to use), not a workaround for a bug.
 */
function computeAgeInYears(birth: IsoDateParts, reference: IsoDateParts): number {
  let age = reference.year - birth.year;

  let effectiveBirthMonth = birth.month;
  let effectiveBirthDay = birth.day;
  if (birth.month === 2 && birth.day === 29 && !isLeapYear(reference.year)) {
    effectiveBirthMonth = 3;
    effectiveBirthDay = 1;
  }

  const birthdayNotYetReachedThisYear =
    reference.month < effectiveBirthMonth || (reference.month === effectiveBirthMonth && reference.day < effectiveBirthDay);
  if (birthdayNotYetReachedThisYear) {
    age -= 1;
  }

  return age;
}

/**
 * Computes VisitSaudi's required Marital Status value from an applicant's
 * date of birth, evaluated as of the group's own departure date (never
 * "today" -- the portal value must stay correct however long before the
 * actual trip this draft is prepared). Never guesses on a malformed or
 * calendar-impossible input -- returns `{ ok: false }` instead.
 */
export function computeMaritalStatusForVisitSaudi(
  dateOfBirthIso: string,
  departureDateIso: string,
): ComputeMaritalStatusForVisitSaudiResult {
  if (!ISO_DATE_PATTERN.test(dateOfBirthIso) || !isRealCalendarDate(dateOfBirthIso)) {
    return { ok: false, reason: 'INVALID_DATE_OF_BIRTH' };
  }
  if (!ISO_DATE_PATTERN.test(departureDateIso) || !isRealCalendarDate(departureDateIso)) {
    return { ok: false, reason: 'INVALID_DEPARTURE_DATE' };
  }

  const age = computeAgeInYears(parseIsoDateParts(dateOfBirthIso), parseIsoDateParts(departureDateIso));
  return { ok: true, maritalStatus: age >= MARITAL_STATUS_AGE_THRESHOLD ? 'MARRIED' : 'SINGLE' };
}
