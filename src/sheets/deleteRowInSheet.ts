import { getConfiguredApiTimeoutMs, getSheetsClients } from './sheetsAuth.js';
import { FIRST_DATA_ROW_NUMBER, FIRST_VISIBLE_COLUMN_LETTER, TECHNICAL_ID_COLUMN_LETTER, withSheetTitle } from './sheetLayout.js';
import { buildRealSheetTitleResolver, type ResolveSheetTitleByGid } from './upsertRowInSheet.js';

/**
 * A completely separate client interface from upsertRowInSheet.ts's own
 * SheetsWriteClient — deliberately never extends or modifies it, so that
 * file's existing behavior and test suite (tests/sheets.upsertRowInSheet.
 * test.ts) are untouched by this feature. Adding a new required method to
 * SheetsWriteClient itself would force every existing fake client in that
 * test file to implement it too, which is exactly what must not happen.
 */
export interface SheetsDeleteClient {
  /**
   * Same shape/semantics as SheetsWriteClient.getAllDataRows — every
   * existing data row, A..M, starting at FIRST_DATA_ROW_NUMBER.
   * `sheetTitle` is additive and optional — see upsertRowInSheet.ts's
   * SheetsWriteClient.getAllDataRows for the exact same convention (omitted
   * targets the spreadsheet's default/first sheet, unchanged legacy
   * behavior; a master/tab caller passes the tab's live-resolved title).
   */
  getAllDataRows(spreadsheetId: string, sheetTitle?: string): Promise<string[][]>;
  /**
   * The numeric sheetId (gid) of this spreadsheet's one data tab — needed
   * by deleteRow's DeleteDimensionRequest, which addresses rows by grid
   * index, not by name. Only ever used for a LEGACY (one-dedicated-file)
   * spreadsheet, which genuinely has exactly one data tab — a master/tab
   * group instead already has its own stable gid (groups.google_sheet_gid)
   * and never calls this.
   */
  getPrimarySheetId(spreadsheetId: string): Promise<number>;
  /** Physically removes ONE row via batchUpdate's DeleteDimensionRequest — shifts every row below it up by one. rowNumber is 1-indexed, matching the rest of this codebase's sheet-row conventions (e.g. FIRST_DATA_ROW_NUMBER). Addressed purely by numeric sheetId — never needs a tab title. */
  deleteRow(spreadsheetId: string, sheetId: number, rowNumber: number): Promise<void>;
  /** Rewrites column A (№) for every row in `rows`, sequentially starting at 1, in ONE batched values.update — never a per-row write. `sheetTitle`: see getAllDataRows. */
  renumberColumnA(spreadsheetId: string, rows: readonly string[][], sheetTitle?: string): Promise<void>;
}

export function buildRealSheetsDeleteClient(getClients: typeof getSheetsClients = getSheetsClients): SheetsDeleteClient {
  return {
    async getAllDataRows(spreadsheetId, sheetTitle) {
      const { sheets } = getClients();
      const range = withSheetTitle(`${FIRST_VISIBLE_COLUMN_LETTER}${FIRST_DATA_ROW_NUMBER}:${TECHNICAL_ID_COLUMN_LETTER}`, sheetTitle);
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
    async renumberColumnA(spreadsheetId, rows, sheetTitle) {
      const { sheets } = getClients();
      if (rows.length === 0) {
        return;
      }
      const range = withSheetTitle(
        `${FIRST_VISIBLE_COLUMN_LETTER}${FIRST_DATA_ROW_NUMBER}:${FIRST_VISIBLE_COLUMN_LETTER}${FIRST_DATA_ROW_NUMBER + rows.length - 1}`,
        sheetTitle,
      );
      const values = rows.map((_, index) => [String(index + 1)]);
      await sheets.spreadsheets.values.update(
        { spreadsheetId, range, valueInputOption: 'RAW', requestBody: { values } },
        { timeout: getConfiguredApiTimeoutMs() },
      );
    },
  };
}

const defaultResolveSheetTitle: ResolveSheetTitleByGid = buildRealSheetTitleResolver();

const defaultClient: SheetsDeleteClient = buildRealSheetsDeleteClient();

export interface DeleteCanonicalRowInput {
  spreadsheetId: string;
  /** The message id currently expected in column M of the row to delete — re-verified fresh against the live sheet before any write, never trusted blindly. */
  expectedCanonicalTelegramMessageId: string;
  /**
   * Additive and optional. Omitted/null (every legacy, one-dedicated-file
   * group today) uses spreadsheetId's own default/first sheet via
   * getPrimarySheetId, exactly as before this field existed. A number (a
   * master/tab group's groups.google_sheet_gid) makes this call resolve
   * that tab's CURRENT live title (for building A:M ranges) and use the
   * gid itself directly as deleteRow's sheetId — never getPrimarySheetId,
   * never sheets[0].
   */
  googleSheetGid?: number | null;
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
 *
 * Master/tab groups (input.googleSheetGid set): before touching the sheet
 * at all, resolves that gid's CURRENT tab title live via resolveSheetTitle
 * — never cached, never read back from any stored value (same principle,
 * same helper, as upsertRowInSheet.ts's own resolution step). That
 * resolution happening first means an unresolvable gid or a
 * spreadsheets.get failure throws immediately, before any read, delete, or
 * renumber call is ever made. The resolved title is threaded through the
 * read and the renumber (both are range-addressed); the delete itself
 * needs no title at all — it addresses the tab purely by the numeric gid,
 * which for a master/tab group is input.googleSheetGid directly, never
 * getPrimarySheetId's sheets[0] lookup.
 */
export async function deleteCanonicalRow(
  input: DeleteCanonicalRowInput,
  client: SheetsDeleteClient = defaultClient,
  resolveSheetTitle: ResolveSheetTitleByGid = defaultResolveSheetTitle,
): Promise<DeleteCanonicalRowResult> {
  const sheetTitle =
    input.googleSheetGid !== undefined && input.googleSheetGid !== null
      ? await resolveSheetTitle(input.spreadsheetId, input.googleSheetGid)
      : undefined;

  const rows = await client.getAllDataRows(input.spreadsheetId, sheetTitle);
  const rowIndex = rows.findIndex((row) => row[12] === input.expectedCanonicalTelegramMessageId);

  if (rowIndex === -1) {
    return { outcome: 'not_found' };
  }

  const rowNumber = FIRST_DATA_ROW_NUMBER + rowIndex;
  const sheetId =
    input.googleSheetGid !== undefined && input.googleSheetGid !== null
      ? input.googleSheetGid
      : await client.getPrimarySheetId(input.spreadsheetId);
  await client.deleteRow(input.spreadsheetId, sheetId, rowNumber);

  await renumberFromFreshRead(input.spreadsheetId, client, sheetTitle);

  return { outcome: 'deleted', rowNumber };
}

/**
 * Re-reads the current data range and rewrites column A sequentially from
 * that fresh state — the recovery primitive if a crash happens between a
 * delete and its renumber (see recoverStalePassportOperatorCommands in
 * Phase E): safe to call any number of times, since it always recomputes
 * from scratch rather than applying a relative adjustment.
 */
export async function renumberFromFreshRead(spreadsheetId: string, client: SheetsDeleteClient = defaultClient, sheetTitle?: string): Promise<void> {
  const rows = await client.getAllDataRows(spreadsheetId, sheetTitle);
  await client.renumberColumnA(spreadsheetId, rows, sheetTitle);
}
