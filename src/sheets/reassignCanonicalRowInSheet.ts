import { buildRealSheetsWriteClient, buildRealSheetTitleResolver, type ResolveSheetTitleByGid, type SheetsWriteClient } from './upsertRowInSheet.js';
import { FIRST_DATA_ROW_NUMBER } from './sheetLayout.js';

const defaultClient: SheetsWriteClient = buildRealSheetsWriteClient();
const defaultResolveSheetTitle: ResolveSheetTitleByGid = buildRealSheetTitleResolver();

export interface ReassignCanonicalRowInput {
  spreadsheetId: string;
  /** The message id CURRENTLY in column M — the row is located by this, not by the new one. */
  oldCanonicalTelegramMessageId: string;
  /** The message id to write into column M — the new canonical. */
  newCanonicalTelegramMessageId: string;
  /** Exactly buildSheetRow()'s 12-element output for the NEW canonical's own data. */
  row: readonly string[];
  /**
   * Additive and optional. Omitted/null (every legacy, one-dedicated-file
   * group today) targets spreadsheetId's own default/first sheet, exactly
   * as before this field existed. A number (a master/tab group's
   * groups.google_sheet_gid) makes this call resolve that tab's CURRENT
   * live title (via upsertRowInSheet.ts's own resolver — no separate
   * resolution logic here) and target it specifically — never sheets[0].
   */
  googleSheetGid?: number | null;
}

export type ReassignCanonicalRowResult =
  | { outcome: 'reassigned'; rowNumber: number }
  | { outcome: 'not_found' };

/**
 * Repoints an existing Sheet row from one canonical message to another —
 * the "canonical reassignment" case from design spec §F/§H, distinct from
 * upsertRowInSheet.ts's own upsert: that function looks a row up by the
 * SAME id it's about to write, which is exactly wrong here (no row yet
 * carries the NEW id — it still carries the OLD one). Deliberately reuses
 * upsertRowInSheet.ts's existing SheetsWriteClient/updateVisibleRow rather
 * than introducing a parallel write primitive — this is an ordinary
 * columns-B:M update, the same operation upsertRowInSheet already performs
 * for its own "found existing row" case, just keyed differently.
 *
 * Never touches column A (№) — updateVisibleRow only ever writes B:M,
 * same guarantee as every other update-in-place path in this codebase.
 *
 * Master/tab groups (input.googleSheetGid set): before touching the sheet
 * at all, resolves that gid's CURRENT tab title live via resolveSheetTitle
 * — the exact same resolver upsertRowInSheet.ts/deleteRowInSheet.ts already
 * use, never a separately re-implemented lookup. That resolution happening
 * first means an unresolvable gid or a spreadsheets.get failure throws
 * immediately, before any read or write is ever made. The resolved title
 * is threaded through both the read and the write, so they always target
 * the same tab. Legacy groups (googleSheetGid null/undefined) pass
 * sheetTitle as undefined throughout — the exact prior behavior
 * (spreadsheetId's own default/first sheet), completely unchanged.
 */
export async function reassignCanonicalRow(
  input: ReassignCanonicalRowInput,
  client: SheetsWriteClient = defaultClient,
  resolveSheetTitle: ResolveSheetTitleByGid = defaultResolveSheetTitle,
): Promise<ReassignCanonicalRowResult> {
  const sheetTitle =
    input.googleSheetGid !== undefined && input.googleSheetGid !== null
      ? await resolveSheetTitle(input.spreadsheetId, input.googleSheetGid)
      : undefined;

  const rows = await client.getAllDataRows(input.spreadsheetId, sheetTitle);
  const rowIndex = rows.findIndex((row) => row[12] === input.oldCanonicalTelegramMessageId);

  if (rowIndex === -1) {
    return { outcome: 'not_found' };
  }

  const rowNumber = FIRST_DATA_ROW_NUMBER + rowIndex;
  const valuesFromColumnB = [...input.row.slice(1), input.newCanonicalTelegramMessageId];
  await client.updateVisibleRow(input.spreadsheetId, rowNumber, valuesFromColumnB, sheetTitle);
  return { outcome: 'reassigned', rowNumber };
}
