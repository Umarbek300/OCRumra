/**
 * Shared sheet column/header contract, referenced by ensureGroupSheet.ts
 * (writes the header row on a freshly-created spreadsheet) and
 * upsertRowInSheet.ts (reads/writes rows against these same boundaries).
 * Kept as one small, dependency-free module so neither file has to import
 * from the other. Deliberately independent of buildSheetRow.ts's own
 * SHEET_ROW_COLUMN_COUNT constant — both happen to be 12, checked by a
 * test, rather than one importing the other, since buildSheetRow.ts is not
 * to be modified in this stage.
 */

/** The approved, user-facing columns, in order — never reordered, never extended without updating buildSheetRow.ts too. */
export const VISIBLE_COLUMN_HEADERS = [
  '№',
  'Ism',
  'Familiya',
  'Passport №',
  "Tug'ilgan sana",
  'Berilgan sana',
  'Amal qilish sanasi',
  'Jins',
  'Agent',
  'Paket',
  'Depozit',
  'Qoldiq',
] as const;

export const VISIBLE_COLUMN_COUNT = VISIBLE_COLUMN_HEADERS.length; // 12

/**
 * One extra, technical-only column after the 12 visible ones (column M),
 * holding the telegram_messages UUID a row was written for. Never shown to
 * operators as meaningful data — it exists purely so upsertRowInSheet.ts
 * can find "the row for this message" again on a retry, instead of
 * re-appending a duplicate. The 12-column user-facing schema (A:L) is
 * never touched by its presence.
 */
export const TECHNICAL_ID_HEADER = 'telegram_message_id (texnik ustun — tahrirlamang)';

export const SHEET_HEADER_ROW: readonly string[] = [...VISIBLE_COLUMN_HEADERS, TECHNICAL_ID_HEADER];

export const HEADER_ROW_NUMBER = 1;
export const FIRST_DATA_ROW_NUMBER = 2;

/** A1-notation column letters — single letters only, matching the fixed 13-column layout above. */
export const FIRST_VISIBLE_COLUMN_LETTER = 'A';
export const LAST_VISIBLE_COLUMN_LETTER = 'L';
export const TECHNICAL_ID_COLUMN_LETTER = 'M';

export const HEADER_RANGE_A1 = `${FIRST_VISIBLE_COLUMN_LETTER}${HEADER_ROW_NUMBER}:${TECHNICAL_ID_COLUMN_LETTER}${HEADER_ROW_NUMBER}`;
export const FULL_ROW_RANGE_COLUMNS = `${FIRST_VISIBLE_COLUMN_LETTER}:${TECHNICAL_ID_COLUMN_LETTER}`;

/**
 * Escapes a tab title for safe use as an A1-notation sheet-name prefix
 * ('<title>'!<range>), per Google Sheets' own escaping rule: wrap in single
 * quotes, and double any single quote that appears inside the title itself
 * (e.g. "Bob's Group" -> 'Bob''s Group').
 */
export function escapeSheetTitleForA1(title: string): string {
  return `'${title.replace(/'/g, "''")}'`;
}

/**
 * Prefixes a bare A1 range with a tab title, per Google Sheets' own
 * "'<title>'!<range>" syntax. `sheetTitle` is additive and optional: every
 * existing caller in this codebase omits it today and gets back the exact
 * same unprefixed range as before (Sheets then resolves that against the
 * spreadsheet's first/default sheet — today's one-file-per-group behavior,
 * completely unchanged). Only a future, tab-aware caller passes it.
 *
 * A tab's title is never cached or persisted anywhere in this codebase as
 * an addressing key — a human can rename a tab at any time — so whatever
 * title a caller passes here must always have been re-resolved live (e.g.
 * via spreadsheets.get, keyed by the tab's stable sheetId/gid) immediately
 * before building the range, never read back from storage.
 */
export function withSheetTitle(range: string, sheetTitle?: string): string {
  if (sheetTitle === undefined) return range;
  return `${escapeSheetTitleForA1(sheetTitle)}!${range}`;
}

/** Function form of HEADER_RANGE_A1, additionally tab-aware — see withSheetTitle. */
export function headerRangeA1(sheetTitle?: string): string {
  return withSheetTitle(HEADER_RANGE_A1, sheetTitle);
}

/** Function form of FULL_ROW_RANGE_COLUMNS, additionally tab-aware — see withSheetTitle. */
export function fullRowRangeColumns(sheetTitle?: string): string {
  return withSheetTitle(FULL_ROW_RANGE_COLUMNS, sheetTitle);
}

/** Range for column A:L only (excludes № is included; excludes the technical id column) — used when updating an existing row without touching its № or technical id. */
export function visibleDataRangeForRow(rowNumber: number, sheetTitle?: string): string {
  return withSheetTitle(`${FIRST_VISIBLE_COLUMN_LETTER}${rowNumber}:${LAST_VISIBLE_COLUMN_LETTER}${rowNumber}`, sheetTitle);
}

/** № (column A) is left out on purpose — see visibleDataRangeForRow's doc comment. */
export function columnBAndAfterRangeForRow(rowNumber: number, sheetTitle?: string): string {
  return withSheetTitle(`B${rowNumber}:${TECHNICAL_ID_COLUMN_LETTER}${rowNumber}`, sheetTitle);
}

export function fullRowRange(rowNumber: number, sheetTitle?: string): string {
  return withSheetTitle(`${FIRST_VISIBLE_COLUMN_LETTER}${rowNumber}:${TECHNICAL_ID_COLUMN_LETTER}${rowNumber}`, sheetTitle);
}
