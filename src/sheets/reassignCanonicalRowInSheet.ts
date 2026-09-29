import { buildRealSheetsWriteClient, type SheetsWriteClient } from './upsertRowInSheet.js';
import { FIRST_DATA_ROW_NUMBER } from './sheetLayout.js';

const defaultClient: SheetsWriteClient = buildRealSheetsWriteClient();

export interface ReassignCanonicalRowInput {
  spreadsheetId: string;
  /** The message id CURRENTLY in column M — the row is located by this, not by the new one. */
  oldCanonicalTelegramMessageId: string;
  /** The message id to write into column M — the new canonical. */
  newCanonicalTelegramMessageId: string;
  /** Exactly buildSheetRow()'s 12-element output for the NEW canonical's own data. */
  row: readonly string[];
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
 */
export async function reassignCanonicalRow(
  input: ReassignCanonicalRowInput,
  client: SheetsWriteClient = defaultClient,
): Promise<ReassignCanonicalRowResult> {
  const rows = await client.getAllDataRows(input.spreadsheetId);
  const rowIndex = rows.findIndex((row) => row[12] === input.oldCanonicalTelegramMessageId);

  if (rowIndex === -1) {
    return { outcome: 'not_found' };
  }

  const rowNumber = FIRST_DATA_ROW_NUMBER + rowIndex;
  const valuesFromColumnB = [...input.row.slice(1), input.newCanonicalTelegramMessageId];
  await client.updateVisibleRow(input.spreadsheetId, rowNumber, valuesFromColumnB);
  return { outcome: 'reassigned', rowNumber };
}
