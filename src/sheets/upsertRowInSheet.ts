import { getConfiguredApiTimeoutMs, getSheetsClients } from './sheetsAuth.js';
import {
  columnBAndAfterRangeForRow,
  FIRST_DATA_ROW_NUMBER,
  FIRST_VISIBLE_COLUMN_LETTER,
  fullRowRange,
  TECHNICAL_ID_COLUMN_LETTER,
  withSheetTitle,
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
   *
   * `sheetTitle` is additive and optional: omitted (every legacy caller
   * today) targets the spreadsheet's own default/first sheet, completely
   * unchanged. A master/tab caller passes the tab's CURRENT, live-resolved
   * title (never cached/persisted — see resolveSheetTitleByGid below).
   */
  getAllDataRows(spreadsheetId: string, sheetTitle?: string): Promise<string[][]>;
  /** Writes columns B..M of an existing row — deliberately never touches column A (№). `sheetTitle`: see getAllDataRows. */
  updateVisibleRow(spreadsheetId: string, rowNumber: number, valuesFromColumnB: readonly string[], sheetTitle?: string): Promise<void>;
  /**
   * Writes a brand-new row's full A..M values at an EXPLICIT, already-
   * determined row number via a plain values.update -- never Google's own
   * values.append/table-detection heuristic, which upsertRowInSheet
   * deliberately avoids entirely (see its own doc comment for why).
   * `sheetTitle`: see getAllDataRows.
   */
  writeRowAt(spreadsheetId: string, rowNumber: number, fullValues: readonly string[], sheetTitle?: string): Promise<void>;
}

/**
 * Resolves a tab's CURRENT title from its stable, persistent gid — the
 * only identifier ever stored anywhere (see groups.repo.ts's
 * google_sheet_gid). A human can rename a tab at any time, so its title is
 * never cached, persisted, or reused across calls: every upsertRowInSheet
 * invocation for a master/tab group re-resolves it live, right before
 * building any A1 range with it. Deliberately a standalone function, not a
 * SheetsWriteClient method — it is only ever needed once per
 * upsertRowInSheet call, never per individual read/write.
 */
export type ResolveSheetTitleByGid = (spreadsheetId: string, gid: number) => Promise<string>;

/**
 * Requests only sheets.properties(sheetId,title) — never full sheet
 * contents — and never `sheets[0]`/first-tab: matches strictly on
 * properties.sheetId === gid, the ONLY correct way to address a specific
 * tab inside a multi-tab master spreadsheet. Throws a clear, specific
 * error (naming both the gid and the spreadsheet) if no tab has that gid,
 * rather than silently falling back to any other tab.
 */
export function buildRealSheetTitleResolver(getClients: typeof getSheetsClients = getSheetsClients): ResolveSheetTitleByGid {
  return async (spreadsheetId, gid) => {
    const { sheets } = getClients();
    const response = await sheets.spreadsheets.get(
      { spreadsheetId, fields: 'sheets.properties(sheetId,title)' },
      { timeout: getConfiguredApiTimeoutMs() },
    );
    const match = (response.data.sheets ?? []).find((sheet) => sheet.properties?.sheetId === gid);
    const title = match?.properties?.title;
    if (typeof title !== 'string' || title.length === 0) {
      throw new Error(`upsertRowInSheet: no tab with sheetId (gid) ${gid} was found in spreadsheet ${spreadsheetId}`);
    }
    return title;
  };
}

const defaultResolveSheetTitle: ResolveSheetTitleByGid = buildRealSheetTitleResolver();

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
    async getAllDataRows(spreadsheetId, sheetTitle) {
      const { sheets } = getClients();
      // Open-ended "A2:M" -- deliberately not fullRowRange(row), which
      // targets a single row. Reading the WHOLE data area in one call, not
      // just column M, is what makes the position of every row (including
      // any blank/foreign one) reliable -- see this client's own doc
      // comment on the SheetsWriteClient interface above. withSheetTitle
      // leaves this exactly as before (no prefix) when sheetTitle is
      // omitted -- the legacy, single-sheet-per-file behavior.
      const range = withSheetTitle(`${FIRST_VISIBLE_COLUMN_LETTER}${FIRST_DATA_ROW_NUMBER}:${TECHNICAL_ID_COLUMN_LETTER}`, sheetTitle);
      const response = await sheets.spreadsheets.values.get({ spreadsheetId, range }, { timeout: getConfiguredApiTimeoutMs() });
      return (response.data.values ?? []) as string[][];
    },
    async updateVisibleRow(spreadsheetId, rowNumber, valuesFromColumnB, sheetTitle) {
      const { sheets } = getClients();
      await sheets.spreadsheets.values.update(
        {
          spreadsheetId,
          range: columnBAndAfterRangeForRow(rowNumber, sheetTitle),
          valueInputOption: 'RAW',
          requestBody: { values: [[...valuesFromColumnB]] },
        },
        { timeout: getConfiguredApiTimeoutMs() },
      );
    },
    async writeRowAt(spreadsheetId, rowNumber, fullValues, sheetTitle) {
      const { sheets } = getClients();
      await sheets.spreadsheets.values.update(
        {
          spreadsheetId,
          range: fullRowRange(rowNumber, sheetTitle),
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
  /**
   * Additive and optional. Omitted/null (every legacy, one-dedicated-file
   * group today) targets spreadsheetId's own default/first sheet, exactly
   * as before this field existed. A number (a master/tab group's
   * groups.google_sheet_gid) makes this call resolve that tab's CURRENT
   * live title and target it specifically — never `sheets[0]`, never a
   * cached/stale title.
   */
  googleSheetGid?: number | null;
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
 *
 * Master/tab groups (input.googleSheetGid set): before touching the sheet
 * at all, resolves that gid's CURRENT tab title live via resolveSheetTitle
 * — never cached, never read back from any stored value, since a human can
 * rename a tab at any time (see ResolveSheetTitleByGid's own doc comment).
 * That resolution happening first means an unresolvable gid or a
 * spreadsheets.get failure throws immediately, before any read or write
 * call is ever made — this function never partially writes against an
 * unverified tab. The resolved title is then threaded through every
 * client call below, so the read (getAllDataRows) and whichever write
 * follows always target the exact same tab. Legacy groups
 * (googleSheetGid null/undefined) pass sheetTitle as undefined throughout,
 * which is the exact prior behavior (spreadsheetId's own default/first
 * sheet), completely unchanged.
 */
export async function upsertRowInSheet(
  input: UpsertRowInSheetInput,
  client: SheetsWriteClient = defaultClient,
  resolveSheetTitle: ResolveSheetTitleByGid = defaultResolveSheetTitle,
): Promise<UpsertRowInSheetResult> {
  const sheetTitle =
    input.googleSheetGid !== undefined && input.googleSheetGid !== null
      ? await resolveSheetTitle(input.spreadsheetId, input.googleSheetGid)
      : undefined;

  const rows = await client.getAllDataRows(input.spreadsheetId, sheetTitle);
  const existingIndex = rows.findIndex((row) => row[12] === input.telegramMessageId);

  if (existingIndex !== -1) {
    const rowNumber = FIRST_DATA_ROW_NUMBER + existingIndex;
    const valuesFromColumnB = [...input.row.slice(1), input.telegramMessageId];
    await client.updateVisibleRow(input.spreadsheetId, rowNumber, valuesFromColumnB, sheetTitle);
    return { action: 'updated', rowNumber };
  }

  // One row past Google's own last-known-content row (see getAllDataRows'
  // own doc comment) — guaranteed blank in A:M, whatever pollution exists
  // earlier in the sheet. № mirrors this row's own 1-based data-row
  // position, matching what upsertRowInSheet has always shown in column A.
  const rowNumber = FIRST_DATA_ROW_NUMBER + rows.length;
  const dataRowSequenceNumber = rows.length + 1;
  const fullValues = [String(dataRowSequenceNumber), ...input.row.slice(1), input.telegramMessageId];
  await client.writeRowAt(input.spreadsheetId, rowNumber, fullValues, sheetTitle);
  return { action: 'appended', rowNumber };
}
