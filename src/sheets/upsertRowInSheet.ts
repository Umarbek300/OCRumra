import { getConfiguredApiTimeoutMs, getSheetsClients } from './sheetsAuth.js';
import { FIRST_DATA_ROW_NUMBER, FULL_ROW_RANGE_COLUMNS, TECHNICAL_ID_COLUMN_LETTER, columnBAndAfterRangeForRow } from './sheetLayout.js';

export interface SheetsWriteClient {
  /** Every value in the technical id column, in row order, starting at FIRST_DATA_ROW_NUMBER — never the header row. */
  getTechnicalIdColumn(spreadsheetId: string): Promise<string[]>;
  /** Writes columns B..M of an existing row — deliberately never touches column A (№). */
  updateVisibleRow(spreadsheetId: string, rowNumber: number, valuesFromColumnB: readonly string[]): Promise<void>;
  /** Appends a brand-new row across A..M, returning the sheet row number Google actually assigned it. */
  appendFullRow(spreadsheetId: string, fullValues: readonly string[]): Promise<{ rowNumber: number }>;
}

/** Parses e.g. "Sheet1!A15:M15" -> 15. Exported for its own focused unit test. */
export function parseRowNumberFromA1Range(a1Range: string | null | undefined): number | null {
  if (!a1Range) return null;
  const match = a1Range.match(/![A-Z]+(\d+)/);
  if (!match) return null;
  const rowNumber = Number(match[1]);
  return Number.isFinite(rowNumber) && rowNumber > 0 ? rowNumber : null;
}

/**
 * getClients defaults to the real getSheetsClients but is overridable —
 * exported (and injectable) purely so a test can verify the timeout option
 * below actually reaches each call's real gaxios request options, using a
 * fake {sheets, drive} pair instead of hitting a real Google account. This
 * never changes what a normal caller (defaultClient below) does.
 *
 * Every call passes `{ timeout: getConfiguredApiTimeoutMs() }` — see
 * ensureGroupSheet.ts's buildRealProvisioningClient doc comment for why
 * (same mechanism, same reasoning, applied here to every Sheets read/write
 * this module makes).
 */
export function buildRealSheetsWriteClient(getClients: typeof getSheetsClients = getSheetsClients): SheetsWriteClient {
  return {
    async getTechnicalIdColumn(spreadsheetId) {
      const { sheets } = getClients();
      const range = `${TECHNICAL_ID_COLUMN_LETTER}${FIRST_DATA_ROW_NUMBER}:${TECHNICAL_ID_COLUMN_LETTER}`;
      const response = await sheets.spreadsheets.values.get({ spreadsheetId, range }, { timeout: getConfiguredApiTimeoutMs() });
      const values = response.data.values ?? [];
      return values.map((row) => row[0] ?? '');
    },
    async updateVisibleRow(spreadsheetId, rowNumber, valuesFromColumnB) {
      const { sheets } = getClients();
      await sheets.spreadsheets.values.update(
        {
          spreadsheetId,
          range: columnBAndAfterRangeForRow(rowNumber),
          valueInputOption: 'RAW',
          requestBody: { values: [[...valuesFromColumnB]] },
        },
        { timeout: getConfiguredApiTimeoutMs() },
      );
    },
    async appendFullRow(spreadsheetId, fullValues) {
      const { sheets } = getClients();
      const response = await sheets.spreadsheets.values.append(
        {
          spreadsheetId,
          range: FULL_ROW_RANGE_COLUMNS,
          valueInputOption: 'RAW',
          insertDataOption: 'INSERT_ROWS',
          requestBody: { values: [[...fullValues]] },
        },
        { timeout: getConfiguredApiTimeoutMs() },
      );
      const rowNumber = parseRowNumberFromA1Range(response.data.updates?.updatedRange);
      if (rowNumber === null) {
        throw new Error(
          `Google Sheets append did not return a parseable row number (updatedRange=${response.data.updates?.updatedRange ?? 'undefined'})`,
        );
      }
      return { rowNumber };
    },
  };
}

const defaultClient: SheetsWriteClient = buildRealSheetsWriteClient();

export interface UpsertRowInSheetInput {
  spreadsheetId: string;
  telegramMessageId: string;
  /** Exactly buildSheetRow()'s 12-element output (see src/sheets/buildSheetRow.ts). row[0] (№) is never used from here — see doc comment below. */
  row: readonly string[];
}

export type UpsertRowInSheetAction = 'updated' | 'appended';

export interface UpsertRowInSheetResult {
  action: UpsertRowInSheetAction;
  /** The row's actual position in the sheet (1-indexed, header included) — what sheet_sync_queue.sheet_row_number records. */
  rowNumber: number;
}

/**
 * Idempotent upsert keyed by telegram_message_id, written into the hidden
 * technical column M (see sheetLayout.ts): searches column M for this
 * message's id.
 *  - Found -> UPDATEs that row's B:M range in place. Column A (№) is
 *    deliberately left untouched, so a retry can never renumber an
 *    existing row.
 *  - Not found -> APPENDs a brand-new row across A:M, computing № from
 *    the current data-row count (existing rows + 1, based on the sheet's
 *    own current data, per the approved design).
 *
 * This function's own read-then-write is NOT atomic on the Sheets side —
 * Sheets has no transaction primitive spanning two API calls. The actual
 * guarantee against two concurrent syncs of the SAME message double-
 * appending comes from sheet_sync_queue's single-claim (only one worker
 * can ever hold a given job in 'syncing' at a time — see
 * sheetSyncQueue.repo.ts's markSheetSyncStarted). What this function's
 * column-M lookup protects against is a SEQUENTIAL retry (e.g. a crash
 * after Sheets confirmed the write but before this process recorded
 * success) correctly finding and updating the already-written row instead
 * of appending a duplicate.
 *
 * Assumes every data row's technical-id column is always populated
 * together with the rest of the row (true for every row this function
 * itself ever writes) — a manually edited sheet with a gap in column M is
 * out of scope for this stage.
 *
 * Every underlying Sheets call this makes (via SheetsWriteClient) is
 * bounded by GOOGLE_SHEETS_API_TIMEOUT_MS (see buildRealSheetsWriteClient
 * below) — a hung/slow request rejects instead of blocking this call
 * forever; the caller (syncPassportRowToSheet) treats that rejection like
 * any other failure.
 */
export async function upsertRowInSheet(
  input: UpsertRowInSheetInput,
  client: SheetsWriteClient = defaultClient,
): Promise<UpsertRowInSheetResult> {
  const idColumn = await client.getTechnicalIdColumn(input.spreadsheetId);
  const existingIndex = idColumn.findIndex((id) => id === input.telegramMessageId);

  if (existingIndex !== -1) {
    const rowNumber = FIRST_DATA_ROW_NUMBER + existingIndex;
    const valuesFromColumnB = [...input.row.slice(1), input.telegramMessageId];
    await client.updateVisibleRow(input.spreadsheetId, rowNumber, valuesFromColumnB);
    return { action: 'updated', rowNumber };
  }

  const nextRowIndex = idColumn.length + 1; // data-row-relative № (1-based), independent of the absolute sheet row Google assigns
  const fullValues = [String(nextRowIndex), ...input.row.slice(1), input.telegramMessageId];
  const { rowNumber } = await client.appendFullRow(input.spreadsheetId, fullValues);
  return { action: 'appended', rowNumber };
}
