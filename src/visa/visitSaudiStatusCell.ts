import { getConfiguredApiTimeoutMs, getSheetsClients } from '../sheets/sheetsAuth.js';
import { FIRST_DATA_ROW_NUMBER, withSheetTitle } from '../sheets/sheetLayout.js';

/**
 * PROPOSED column for VisitSaudi's own per-applicant submission status --
 * the next free column after the existing Q:V visa block (see
 * visaSheetColumns.ts's own VISA_LAST_COLUMN_LETTER = 'V'). This is a
 * proposal only: it is NOT wired into visaSheetColumns.ts, and nothing in
 * this module ever creates this column or writes to a real spreadsheet --
 * actually adding it to the live Sheet layout is a separate, later step
 * requiring its own approval.
 */
export const VISA_STATUS_COLUMN = 'W';

export const VISA_STATUS_VALUES = ['PENDING', 'SAVED', 'ERROR'] as const;
export type VisaStatusValue = (typeof VISA_STATUS_VALUES)[number];

function isVisaStatusValue(value: string): value is VisaStatusValue {
  return (VISA_STATUS_VALUES as readonly string[]).includes(value);
}

/**
 * Same hidden technical column (M), 0-indexed, every other Sheets reader/
 * writer in this codebase already relies on (see readVerifiedApplicantData.ts,
 * upsertRowInSheet.ts, visitSaudiPreflight.ts) -- never a guessed or
 * assumed row position.
 */
const TECHNICAL_ID_COLUMN_INDEX = 12;

export interface VisaStatusCellClient {
  /** Every existing data row, A..VISA_STATUS_COLUMN, in row order, starting at FIRST_DATA_ROW_NUMBER -- same "read the whole relevant range" rationale as readVerifiedApplicantData.ts/upsertRowInSheet.ts's own clients. */
  getAllDataRows(spreadsheetId: string, sheetTitle?: string): Promise<string[][]>;
  getCell(spreadsheetId: string, column: string, rowNumber: number, sheetTitle?: string): Promise<string>;
  /** Writes exactly ONE cell -- never a full row, never any column other than the one explicitly passed in. */
  setCell(spreadsheetId: string, column: string, rowNumber: number, value: string, sheetTitle?: string): Promise<void>;
}

function cellRange(column: string, rowNumber: number, sheetTitle?: string): string {
  return withSheetTitle(`${column}${rowNumber}`, sheetTitle);
}

/**
 * Real Sheets-API-backed client, built in the exact same single-cell get/
 * set style as writePersonalPhotoUrlIfBlank.ts's own PhotoUrlCellClient
 * (used here as a PATTERN only -- that file itself is never imported or
 * modified). Never calls spreadsheets.values.update with a range wider than
 * one cell, so it structurally cannot touch any other column or row.
 */
export function buildRealVisaStatusCellClient(getClients: typeof getSheetsClients = getSheetsClients): VisaStatusCellClient {
  return {
    async getAllDataRows(spreadsheetId, sheetTitle) {
      const { sheets } = getClients();
      const range = withSheetTitle(`A${FIRST_DATA_ROW_NUMBER}:${VISA_STATUS_COLUMN}`, sheetTitle);
      const response = await sheets.spreadsheets.values.get({ spreadsheetId, range }, { timeout: getConfiguredApiTimeoutMs() });
      return (response.data.values ?? []) as string[][];
    },
    async getCell(spreadsheetId, column, rowNumber, sheetTitle) {
      const { sheets } = getClients();
      const response = await sheets.spreadsheets.values.get(
        { spreadsheetId, range: cellRange(column, rowNumber, sheetTitle) },
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
          range: cellRange(column, rowNumber, sheetTitle),
          valueInputOption: 'RAW',
          requestBody: { values: [[value]] },
        },
        { timeout: getConfiguredApiTimeoutMs() },
      );
    },
  };
}

const defaultClient: VisaStatusCellClient = buildRealVisaStatusCellClient();

export type FindApplicantRowResult = { ok: true; rowNumber: number } | { ok: false; reason: 'ROW_NOT_FOUND' };

/**
 * Finds an applicant's CURRENT row by content-matching the hidden technical
 * column M against telegramMessageId -- the same mechanism
 * upsertRowInSheet.ts / readVerifiedApplicantData.ts / visitSaudiPreflight.ts
 * already use -- never a row index assumed from created_at order, from the
 * previous call's own result, or from any other guess. Re-resolves fresh on
 * every call, so a row that moved since an earlier read is still found
 * correctly.
 */
async function findApplicantRow(
  spreadsheetId: string,
  telegramMessageId: string,
  sheetTitle: string | undefined,
  client: Pick<VisaStatusCellClient, 'getAllDataRows'>,
): Promise<FindApplicantRowResult> {
  const rows = await client.getAllDataRows(spreadsheetId, sheetTitle);
  const index = rows.findIndex((row) => row[TECHNICAL_ID_COLUMN_INDEX] === telegramMessageId);
  if (index === -1) {
    return { ok: false, reason: 'ROW_NOT_FOUND' };
  }
  return { ok: true, rowNumber: FIRST_DATA_ROW_NUMBER + index };
}

export type ReadVisaStatusResult =
  | { ok: true; status: VisaStatusValue | null } // null = cell is currently blank, never written yet -- never guessed as a real status
  | { ok: false; reason: 'ROW_NOT_FOUND' | 'INVALID_STORED_VALUE' | 'SHEETS_API_ERROR'; detail?: string };

export type WriteVisaStatusResult =
  | { ok: true; rowNumber: number }
  | { ok: false; reason: 'INVALID_STATUS_VALUE' | 'ROW_NOT_FOUND' | 'SHEETS_API_ERROR'; detail?: string };

/**
 * Reads this ONE applicant's current VisitSaudi status cell. Never throws:
 * a Sheets API failure, a row that cannot be found, or a value sitting in
 * the cell that isn't one of VISA_STATUS_VALUES are all returned as a
 * `{ ok: false }` result instead -- an operator-typed stray value is
 * reported, never silently accepted as if it were a real status.
 */
export async function readVisaStatus(
  spreadsheetId: string,
  telegramMessageId: string,
  sheetTitle?: string,
  client: VisaStatusCellClient = defaultClient,
): Promise<ReadVisaStatusResult> {
  const found = await findApplicantRow(spreadsheetId, telegramMessageId, sheetTitle, client);
  if (!found.ok) {
    return { ok: false, reason: 'ROW_NOT_FOUND' };
  }

  let raw: string;
  try {
    raw = await client.getCell(spreadsheetId, VISA_STATUS_COLUMN, found.rowNumber, sheetTitle);
  } catch (error) {
    return { ok: false, reason: 'SHEETS_API_ERROR', detail: error instanceof Error ? error.message : 'unknown error' };
  }

  const trimmed = raw.trim();
  if (trimmed === '') {
    return { ok: true, status: null };
  }
  if (!isVisaStatusValue(trimmed)) {
    return { ok: false, reason: 'INVALID_STORED_VALUE', detail: trimmed };
  }
  return { ok: true, status: trimmed };
}

/**
 * Writes this ONE applicant's VisitSaudi status cell -- deliberately
 * REPEATABLE (unlike writePersonalPhotoUrlIfBlank.ts's blank-only guard,
 * used here only as a style reference, never imported): a status cell must
 * be overwritable as an applicant moves PENDING -> SAVED/ERROR. Rejects any
 * value outside VISA_STATUS_VALUES before touching the Sheet at all -- an
 * invalid status is never written, and the applicant's row is never even
 * looked up for that case. Any Sheets API failure (listing rows or writing
 * the cell) is returned as `{ ok: false }`, never thrown and never hidden.
 */
export async function writeVisaStatus(
  spreadsheetId: string,
  telegramMessageId: string,
  status: string,
  sheetTitle?: string,
  client: VisaStatusCellClient = defaultClient,
): Promise<WriteVisaStatusResult> {
  if (!isVisaStatusValue(status)) {
    return { ok: false, reason: 'INVALID_STATUS_VALUE', detail: status };
  }

  const found = await findApplicantRow(spreadsheetId, telegramMessageId, sheetTitle, client);
  if (!found.ok) {
    return { ok: false, reason: 'ROW_NOT_FOUND' };
  }

  try {
    await client.setCell(spreadsheetId, VISA_STATUS_COLUMN, found.rowNumber, status, sheetTitle);
  } catch (error) {
    return { ok: false, reason: 'SHEETS_API_ERROR', detail: error instanceof Error ? error.message : 'unknown error' };
  }

  return { ok: true, rowNumber: found.rowNumber };
}
