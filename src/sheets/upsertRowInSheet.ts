import { getConfiguredApiTimeoutMs, getSheetsClients } from './sheetsAuth.js';
import {
  columnBAndAfterRangeForRow,
  FIRST_DATA_ROW_NUMBER,
  FIRST_VISIBLE_COLUMN_LETTER,
  fullRowRange,
  TECHNICAL_ID_COLUMN_LETTER,
} from './sheetLayout.js';

export interface SheetsWriteClient {
  /**
   * Every existing data row, A..M, in row order, starting at
   * FIRST_DATA_ROW_NUMBER. Deliberately reads the WHOLE row -- not just
   * column M -- in one call, so mid-range blank/partial rows are correctly
   * positioned: Google Sheets' values.get only ever omits TRAILING
   * fully-blank rows from the end of the returned range; a blank or
   * partial row that precedes later real content is preserved in place
   * (as `[]` or a short array). That single property is what makes both
   * the existing-row lookup and the new-row placement below immune to any
   * pollution or gaps anywhere earlier in the sheet -- see
   * upsertRowInSheet's own doc comment.
   */
  getAllDataRows(spreadsheetId: string): Promise<string[][]>;
  /** Writes columns B..M of an existing row — deliberately never touches column A (№). */
  updateVisibleRow(spreadsheetId: string, rowNumber: number, valuesFromColumnB: readonly string[]): Promise<void>;
  /**
   * Writes a brand-new row's full A..M values at an EXPLICIT, already-
   * determined row number via a plain values.update -- never Google's own
   * values.append/table-detection heuristic, which upsertRowInSheet
   * deliberately avoids entirely (see its own doc comment for why).
   */
  writeRowAt(spreadsheetId: string, rowNumber: number, fullValues: readonly string[]): Promise<void>;
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
    async getAllDataRows(spreadsheetId) {
      const { sheets } = getClients();
      // Open-ended "A2:M" -- deliberately not fullRowRange(row), which
      // targets a single row. Reading the WHOLE data area in one call, not
      // just column M, is what makes the position of every row (including
      // any blank/foreign one) reliable -- see this client's own doc
      // comment on the SheetsWriteClient interface above.
      const range = `${FIRST_VISIBLE_COLUMN_LETTER}${FIRST_DATA_ROW_NUMBER}:${TECHNICAL_ID_COLUMN_LETTER}`;
      const response = await sheets.spreadsheets.values.get({ spreadsheetId, range }, { timeout: getConfiguredApiTimeoutMs() });
      return (response.data.values ?? []) as string[][];
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
    async writeRowAt(spreadsheetId, rowNumber, fullValues) {
      const { sheets } = getClients();
      await sheets.spreadsheets.values.update(
        {
          spreadsheetId,
          range: fullRowRange(rowNumber),
          valueInputOption: 'RAW',
          requestBody: { values: [[...fullValues]] },
        },
        { timeout: getConfiguredApiTimeoutMs() },
      );
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
 * technical column M (see sheetLayout.ts). Reads the WHOLE existing A:M
 * data area exactly once (client.getAllDataRows), then:
 *  - Found (some row's own M cell === this telegram_message_id) -> UPDATEs
 *    that row's B:M range in place. Column A (№) is deliberately left
 *    untouched, so a retry can never renumber an existing row.
 *  - Not found -> writes a brand-new row via an EXPLICIT values.update at
 *    `FIRST_DATA_ROW_NUMBER + rows.length` -- one row past whatever Google
 *    itself reports as the last row with any content anywhere in A:M.
 *    Google's values.get never omits a row that precedes later real
 *    content (only trailing all-blank rows are dropped), so this position
 *    is guaranteed to be genuinely blank in A:M and can never collide with
 *    existing data, however that data got there.
 *
 * Deliberately never uses Sheets' own values.append: append's "find a
 * table, insert after it" behavior is a heuristic this pipeline does not
 * control and cannot make deterministic once a sheet accumulates ANY
 * content this pipeline itself didn't write (a manually pasted note, an
 * unrelated AI-assistant response typed into a cell, a diagnostic marker
 * like "DIAG-TEST", a blank row left by an edit, or simply a row missing
 * one side of A:L/M). Computing the target row ourselves from a single
 * A:M read and writing it with an explicit-range values.update removes
 * that dependency entirely — the seven cases this design is proven safe
 * against are enumerated in tests/sheets.upsertRowInSheet.test.ts.
 *
 * This function's own read-then-write is NOT atomic on the Sheets side —
 * Sheets has no transaction primitive spanning two API calls. The actual
 * guarantee against two concurrent syncs of the SAME message double-
 * writing comes from sheet_sync_queue's single-claim (only one worker can
 * ever hold a given job in 'syncing' at a time — see sheetSyncQueue.repo.
 * ts's markSheetSyncStarted). What this function's own column-M lookup
 * protects against is a SEQUENTIAL retry (e.g. a crash after Sheets
 * confirmed the write but before this process recorded success) correctly
 * finding and updating the already-written row instead of writing a
 * duplicate.
 *
 * Every underlying Sheets call this makes (via SheetsWriteClient) is
 * bounded by GOOGLE_SHEETS_API_TIMEOUT_MS (see buildRealSheetsWriteClient
 * above) — a hung/slow request rejects instead of blocking this call
 * forever; the caller (syncPassportRowToSheet) treats that rejection like
 * any other failure.
 */
export async function upsertRowInSheet(
  input: UpsertRowInSheetInput,
  client: SheetsWriteClient = defaultClient,
): Promise<UpsertRowInSheetResult> {
  const rows = await client.getAllDataRows(input.spreadsheetId);
  const existingIndex = rows.findIndex((row) => row[12] === input.telegramMessageId);

  if (existingIndex !== -1) {
    const rowNumber = FIRST_DATA_ROW_NUMBER + existingIndex;
    const valuesFromColumnB = [...input.row.slice(1), input.telegramMessageId];
    await client.updateVisibleRow(input.spreadsheetId, rowNumber, valuesFromColumnB);
    return { action: 'updated', rowNumber };
  }

  // One row past Google's own last-known-content row (see getAllDataRows'
  // own doc comment) — guaranteed blank in A:M, whatever pollution exists
  // earlier in the sheet. № mirrors this row's own 1-based data-row
  // position, matching what upsertRowInSheet has always shown in column A.
  const rowNumber = FIRST_DATA_ROW_NUMBER + rows.length;
  const dataRowSequenceNumber = rows.length + 1;
  const fullValues = [String(dataRowSequenceNumber), ...input.row.slice(1), input.telegramMessageId];
  await client.writeRowAt(input.spreadsheetId, rowNumber, fullValues);
  return { action: 'appended', rowNumber };
}
