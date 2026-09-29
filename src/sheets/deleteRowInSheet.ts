import { getConfiguredApiTimeoutMs, getSheetsClients } from './sheetsAuth.js';
import { FIRST_DATA_ROW_NUMBER, FIRST_VISIBLE_COLUMN_LETTER, TECHNICAL_ID_COLUMN_LETTER } from './sheetLayout.js';

/**
 * A completely separate client interface from upsertRowInSheet.ts's own
 * SheetsWriteClient — deliberately never extends or modifies it, so that
 * file's existing behavior and test suite (tests/sheets.upsertRowInSheet.
 * test.ts) are untouched by this feature. Adding a new required method to
 * SheetsWriteClient itself would force every existing fake client in that
 * test file to implement it too, which is exactly what must not happen.
 */
export interface SheetsDeleteClient {
  /** Same shape/semantics as SheetsWriteClient.getAllDataRows — every existing data row, A..M, starting at FIRST_DATA_ROW_NUMBER. */
  getAllDataRows(spreadsheetId: string): Promise<string[][]>;
  /** The numeric sheetId (gid) of this spreadsheet's one data tab — needed by deleteRow's DeleteDimensionRequest, which addresses rows by grid index, not by name. */
  getPrimarySheetId(spreadsheetId: string): Promise<number>;
  /** Physically removes ONE row via batchUpdate's DeleteDimensionRequest — shifts every row below it up by one. rowNumber is 1-indexed, matching the rest of this codebase's sheet-row conventions (e.g. FIRST_DATA_ROW_NUMBER). */
  deleteRow(spreadsheetId: string, sheetId: number, rowNumber: number): Promise<void>;
  /** Rewrites column A (№) for every row in `rows`, sequentially starting at 1, in ONE batched values.update — never a per-row write. */
  renumberColumnA(spreadsheetId: string, rows: readonly string[][]): Promise<void>;
}

export function buildRealSheetsDeleteClient(getClients: typeof getSheetsClients = getSheetsClients): SheetsDeleteClient {
  return {
    async getAllDataRows(spreadsheetId) {
      const { sheets } = getClients();
      const range = `${FIRST_VISIBLE_COLUMN_LETTER}${FIRST_DATA_ROW_NUMBER}:${TECHNICAL_ID_COLUMN_LETTER}`;
      const response = await sheets.spreadsheets.values.get({ spreadsheetId, range }, { timeout: getConfiguredApiTimeoutMs() });
      return (response.data.values ?? []) as string[][];
    },
    async getPrimarySheetId(spreadsheetId) {
      const { sheets } = getClients();
      const response = await sheets.spreadsheets.get(
        { spreadsheetId, fields: 'sheets.properties.sheetId' },
        { timeout: getConfiguredApiTimeoutMs() },
      );
      const sheetId = response.data.sheets?.[0]?.properties?.sheetId;
      if (sheetId === undefined || sheetId === null) {
        throw new Error(`getPrimarySheetId: spreadsheet ${spreadsheetId} reported no sheets at all`);
      }
      return sheetId;
    },
    async deleteRow(spreadsheetId, sheetId, rowNumber) {
      const { sheets } = getClients();
      // batchUpdate's DeleteDimensionRequest addresses rows by 0-indexed
      // grid position, end-exclusive — rowNumber is 1-indexed (matching
      // FIRST_DATA_ROW_NUMBER etc.), so startIndex = rowNumber - 1.
      await sheets.spreadsheets.batchUpdate(
        {
          spreadsheetId,
          requestBody: {
            requests: [
              {
                deleteDimension: {
                  range: { sheetId, dimension: 'ROWS', startIndex: rowNumber - 1, endIndex: rowNumber },
                },
              },
            ],
          },
        },
        { timeout: getConfiguredApiTimeoutMs() },
      );
    },
    async renumberColumnA(spreadsheetId, rows) {
      const { sheets } = getClients();
      if (rows.length === 0) {
        return;
      }
      const range = `${FIRST_VISIBLE_COLUMN_LETTER}${FIRST_DATA_ROW_NUMBER}:${FIRST_VISIBLE_COLUMN_LETTER}${FIRST_DATA_ROW_NUMBER + rows.length - 1}`;
      const values = rows.map((_, index) => [String(index + 1)]);
      await sheets.spreadsheets.values.update(
        { spreadsheetId, range, valueInputOption: 'RAW', requestBody: { values } },
        { timeout: getConfiguredApiTimeoutMs() },
      );
    },
  };
}

const defaultClient: SheetsDeleteClient = buildRealSheetsDeleteClient();

export interface DeleteCanonicalRowInput {
  spreadsheetId: string;
  /** The message id currently expected in column M of the row to delete — re-verified fresh against the live sheet before any write, never trusted blindly. */
  expectedCanonicalTelegramMessageId: string;
}

export type DeleteCanonicalRowResult =
  | { outcome: 'deleted'; rowNumber: number }
  /** No row currently has this id in column M — nothing to delete. The caller (Phase E's operator-command processing) is responsible for the broader Postgres-side re-verification (identity/group still match expectations) BEFORE ever calling this function; this Sheets-only primitive knows nothing about identities or groups, only column M. */
  | { outcome: 'not_found' };

/**
 * Physically deletes the Sheet row for `expectedCanonicalTelegramMessageId`
 * and renumbers every remaining row's № in one follow-up batched write —
 * design spec §H's sequenced deletion mechanism.
 *
 * Safety properties:
 *  - Re-reads the full A:M range fresh immediately before acting (never
 *    trusts a previously stored row number) — same principle
 *    upsertRowInSheet.ts already relies on for ordinary writes. Deliberately
 *    does NOT accept a pre-resolved row number from the caller — every call
 *    re-derives it from the live sheet, closing exactly the class of
 *    "wrong row deleted" bug a stale row-number parameter could cause.
 *  - Renumbering is always recomputed wholesale from a fresh read after
 *    the delete, never applied incrementally — naturally idempotent if a
 *    caller must retry after a crash between the delete and the renumber
 *    (re-running this function again on an already-deleted row simply
 *    returns 'not_found', a safe no-op; a caller that instead needs to
 *    retry JUST the renumber step after a partial crash should call
 *    renumberFromFreshRead directly — see below).
 */
export async function deleteCanonicalRow(
  input: DeleteCanonicalRowInput,
  client: SheetsDeleteClient = defaultClient,
): Promise<DeleteCanonicalRowResult> {
  const rows = await client.getAllDataRows(input.spreadsheetId);
  const rowIndex = rows.findIndex((row) => row[12] === input.expectedCanonicalTelegramMessageId);

  if (rowIndex === -1) {
    return { outcome: 'not_found' };
  }

  const rowNumber = FIRST_DATA_ROW_NUMBER + rowIndex;
  const sheetId = await client.getPrimarySheetId(input.spreadsheetId);
  await client.deleteRow(input.spreadsheetId, sheetId, rowNumber);

  await renumberFromFreshRead(input.spreadsheetId, client);

  return { outcome: 'deleted', rowNumber };
}

/**
 * Re-reads the current data range and rewrites column A sequentially from
 * that fresh state — the recovery primitive if a crash happens between a
 * delete and its renumber (see recoverStalePassportOperatorCommands in
 * Phase E): safe to call any number of times, since it always recomputes
 * from scratch rather than applying a relative adjustment.
 */
export async function renumberFromFreshRead(spreadsheetId: string, client: SheetsDeleteClient = defaultClient): Promise<void> {
  const rows = await client.getAllDataRows(spreadsheetId);
  await client.renumberColumnA(spreadsheetId, rows);
}
