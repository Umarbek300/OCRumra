/**
 * Parses a departure date out of a Telegram group's own chat title, for
 * automatic group registration (see ensureGroupRegistered.ts). Pure,
 * side-effect free, and deliberately conservative: the ENTIRE (trimmed)
 * title must match one of the explicitly supported formats below, exactly
 * -- never a substring search, never a best-effort guess. Anything else,
 * including a syntactically-close-but-not-quite match or a calendar-invalid
 * date (e.g. "31 February 2026"), returns null. A null return means the
 * caller must NOT auto-create a group -- the message stays unlinked
 * exactly as it would if this feature didn't exist at all.
 *
 * Supported formats (case-insensitive):
 *   "5 October 2026"    -- D/DD + full month name (English, Uzbek, or
 *   "20 September 2026"    Russian, see MONTH_NAME_TO_NUMBER) + YYYY
 *   "05.10.2026"         -- D/DD.MM.YYYY
 *   "5.10.2026"
 *   "2026-10-05"         -- plain ISO YYYY-MM-DD
 */

export interface ParsedDepartureDate {
  /** YYYY-MM-DD, matching groups.departure_date's own column format. */
  date: string;
}

/**
 * Lowercase month name -> 1-12. English, Uzbek, and Russian (both
 * nominative and genitive forms, since Russian dates conventionally use
 * the genitive -- "5 октября 2026", not "5 октябрь 2026") map to the same
 * numbers. "may" (English) and "may" (Uzbek) are identical spellings, so
 * a single entry already covers both languages for that one month.
 */
const MONTH_NAME_TO_NUMBER: Readonly<Record<string, number>> = {
  // English
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
  // Uzbek
  yanvar: 1,
  fevral: 2,
  mart: 3,
  aprel: 4,
  iyun: 6,
  iyul: 7,
  avgust: 8,
  sentyabr: 9,
  oktyabr: 10,
  oktabr: 10,
  noyabr: 11,
  dekabr: 12,
  // Russian -- nominative
  январь: 1,
  февраль: 2,
  март: 3,
  апрель: 4,
  май: 5,
  июнь: 6,
  июль: 7,
  август: 8,
  сентябрь: 9,
  октябрь: 10,
  ноябрь: 11,
  декабрь: 12,
  // Russian -- genitive (the form actually used in a written date)
  января: 1,
  февраля: 2,
  марта: 3,
  апреля: 4,
  мая: 5,
  июня: 6,
  июля: 7,
  августа: 8,
  сентября: 9,
  октября: 10,
  ноября: 11,
  декабря: 12,
};

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * True calendar validation, not just range checks -- catches "31 February
 * 2026" or "31.04.2026" (April has 30 days) by round-tripping through
 * Date.UTC and confirming the components didn't roll over into the next
 * month.
 */
function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function buildResult(year: number, month: number, day: number): ParsedDepartureDate | null {
  if (!isValidCalendarDate(year, month, day)) {
    return null;
  }
  return { date: `${year}-${pad2(month)}-${pad2(day)}` };
}

/** "5 October 2026" / "20 September 2026" / "5 oktyabr 2026" / "5 октября 2026" -- D/DD + a known month name + YYYY. */
function tryMonthNameFormat(title: string): ParsedDepartureDate | null {
  const match = title.match(/^(\d{1,2})\s+([A-Za-zА-Яа-яЁё]+)\s+(\d{4})$/);
  if (!match) {
    return null;
  }
  const [, dayRaw, monthWordRaw, yearRaw] = match;
  const monthNumber = MONTH_NAME_TO_NUMBER[monthWordRaw!.toLowerCase()];
  if (monthNumber === undefined) {
    return null;
  }
  return buildResult(Number(yearRaw), monthNumber, Number(dayRaw));
}

/** "05.10.2026" / "5.10.2026" -- D/DD.MM.YYYY. */
function tryDottedNumericFormat(title: string): ParsedDepartureDate | null {
  const match = title.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!match) {
    return null;
  }
  const [, dayRaw, monthRaw, yearRaw] = match;
  return buildResult(Number(yearRaw), Number(monthRaw), Number(dayRaw));
}

/** "2026-10-05" -- plain ISO YYYY-MM-DD. */
function tryIsoFormat(title: string): ParsedDepartureDate | null {
  const match = title.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!match) {
    return null;
  }
  const [, yearRaw, monthRaw, dayRaw] = match;
  return buildResult(Number(yearRaw), Number(monthRaw), Number(dayRaw));
}

/**
 * captionText/title === null, empty, or matching none of the supported
 * formats all yield null -- never an error, never a guess. The caller
 * (ensureGroupRegistered.ts) treats null as "do not auto-create a group".
 */
export function parseDepartureDateFromGroupTitle(title: string | null): ParsedDepartureDate | null {
  if (!title) {
    return null;
  }
  const trimmed = title.trim();
  if (!trimmed) {
    return null;
  }
  return tryMonthNameFormat(trimmed) ?? tryDottedNumericFormat(trimmed) ?? tryIsoFormat(trimmed);
}
