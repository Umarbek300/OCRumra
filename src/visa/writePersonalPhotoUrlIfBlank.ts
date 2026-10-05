import { getConfiguredApiTimeoutMs, getSheetsClients } from '../sheets/sheetsAuth.js';
import { withSheetTitle } from '../sheets/sheetLayout.js';

export interface PhotoUrlCellClient {
  getCell(spreadsheetId: string, column: string, rowNumber: number, sheetTitle?: string): Promise<string>;
  setCell(spreadsheetId: string, column: string, rowNumber: number, value: string, sheetTitle?: string): Promise<void>;
}

function photoUrlRange(column: string, rowNumber: number, sheetTitle?: string): string {
  return withSheetTitle(`${column}${rowNumber}`, sheetTitle);
}

export function buildRealPhotoUrlCellClient(getClients: typeof getSheetsClients = getSheetsClients): PhotoUrlCellClient {
  return {
    async getCell(spreadsheetId, column, rowNumber, sheetTitle) {
      const { sheets } = getClients();
      const response = await sheets.spreadsheets.values.get(
        { spreadsheetId, range: photoUrlRange(column, rowNumber, sheetTitle) },
        { timeout: getConfiguredApiTimeoutMs() },
      );
      const value = response.data.values?.[0]?.[0];
      return typeof value === 'string' ? value : '';
    },
    async setCell(spreadsheetId, column, rowNumber, value, sheetTitle) {
      const { sheets } = getClients();
      await sheets.spreadsheets.values.update(
        {
          spreadsheetId,
          range: photoUrlRange(column, rowNumber, sheetTitle),
          valueInputOption: 'RAW',
          requestBody: { values: [[value]] },
        },
        { timeout: getConfiguredApiTimeoutMs() },
      );
    },
  };
}

const defaultClient: PhotoUrlCellClient = buildRealPhotoUrlCellClient();

/**
 * Populates the given single-cell visa Sheet column (e.g. VISA_PERSONAL_
 * PHOTO_URL_COLUMN = 'T' for the original passport image, or VISA_PERSONAL_
 * PORTRAIT_URL_COLUMN = 'V' for the cropped portrait — see
 * visaSheetColumns.ts) ONLY when it is currently blank — an operator's own
 * manually-typed value (the only way either column was ever filled before
 * these features existed, and still a valid override afterward) is NEVER
 * overwritten. Reads the single cell first, then writes only on a blank
 * read. `column` is a required, explicit argument (not defaulted) so every
 * call site states unambiguously which column it targets — this function
 * has no opinion of its own about which artifact (original photo vs.
 * cropped portrait) a given call is for.
 *
 * Not atomic against a concurrent manual edit — Sheets has no such
 * primitive spanning two API calls (same limitation upsertRowInSheet.ts's
 * own doc comment already accepts for its own read-then-write) — but this
 * runs once, right after a row's own OCR sync, so the realistic race
 * window is negligible.
 */
export async function writePersonalPhotoUrlIfBlank(
  spreadsheetId: string,
  rowNumber: number,
  url: string,
  column: string,
  sheetTitle?: string,
  client: PhotoUrlCellClient = defaultClient,
): Promise<'written' | 'skipped-not-blank'> {
  const current = await client.getCell(spreadsheetId, column, rowNumber, sheetTitle);
  if (current.trim() !== '') {
    return 'skipped-not-blank';
  }
  await client.setCell(spreadsheetId, column, rowNumber, url, sheetTitle);
  return 'written';
}
