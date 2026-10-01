import { findActiveCanonicalLink } from '../db/repositories/passportMessageLinks.repo.js';
import { findGroupById } from '../db/repositories/groups.repo.js';
import { ensureGroupSheet } from '../sheets/ensureGroupSheet.js';
import { getConfiguredApiTimeoutMs, getSheetsClients } from '../sheets/sheetsAuth.js';
import { FIRST_DATA_ROW_NUMBER, TECHNICAL_ID_COLUMN_LETTER, withSheetTitle } from '../sheets/sheetLayout.js';
import { buildRealSheetTitleResolver, type ResolveSheetTitleByGid } from '../sheets/upsertRowInSheet.js';
import { VISA_COLUMN_INDEX, VISA_LAST_COLUMN_LETTER } from './visaSheetColumns.js';
import type { VerifiedApplicantData } from './types.js';

export interface VisaSheetReadClient {
  /** Every existing data row, A..U (the full passport table plus the visa columns), in row order, starting at FIRST_DATA_ROW_NUMBER. Same "read the whole row" rationale as upsertRowInSheet.ts's SheetsWriteClient.getAllDataRows -- a short/partial row is preserved in place, never misaligns later rows. */
  getAllDataRows(spreadsheetId: string, sheetTitle?: string): Promise<string[][]>;
}

export function buildRealVisaSheetReadClient(getClients: typeof getSheetsClients = getSheetsClients): VisaSheetReadClient {
  return {
    async getAllDataRows(spreadsheetId, sheetTitle) {
      const { sheets } = getClients();
      const range = withSheetTitle(`A${FIRST_DATA_ROW_NUMBER}:${VISA_LAST_COLUMN_LETTER}`, sheetTitle);
      const response = await sheets.spreadsheets.values.get({ spreadsheetId, range }, { timeout: getConfiguredApiTimeoutMs() });
      return (response.data.values ?? []) as string[][];
    },
  };
}

const defaultClient: VisaSheetReadClient = buildRealVisaSheetReadClient();
const defaultResolveSheetTitle: ResolveSheetTitleByGid = buildRealSheetTitleResolver();

export interface ReadVerifiedApplicantDataDependencies {
  findActiveCanonicalLink: typeof findActiveCanonicalLink;
  findGroup: typeof findGroupById;
  ensureSheet: typeof ensureGroupSheet;
  readClient: VisaSheetReadClient;
  resolveSheetTitle: ResolveSheetTitleByGid;
}

const defaultDependencies: ReadVerifiedApplicantDataDependencies = {
  findActiveCanonicalLink,
  findGroup: findGroupById,
  ensureSheet: ensureGroupSheet,
  readClient: defaultClient,
  resolveSheetTitle: defaultResolveSheetTitle,
};

function cell(row: readonly string[], index: number): string {
  return row[index] ?? '';
}

/**
 * The ONLY read path visa automation ever uses for applicant data. Reads
 * the Google Sheet LIVE, right now -- never passport_ocr_results, never any
 * other DB table's copy of a passport field. Whatever the operator has
 * currently typed into the Sheet (including a correction of an OCR
 * mistake) is what comes back; there is no fallback to an older or
 * DB-cached value when a Sheet cell is blank.
 *
 * Locates the applicant's row via the SAME mechanism every other Sheets
 * write/read in this codebase already uses -- the active canonical link's
 * telegramMessageId, matched against the hidden technical column M -- never
 * a Sheet row index, which a human can reorder/insert/delete freely.
 *
 * Returns null (not an error) when:
 *  - the (identity, group) has no active canonical link (e.g. already
 *    cancelled/removed -- nothing to read), or
 *  - that link's own row cannot be found in the Sheet (should not normally
 *    happen, since every canonical link's message was synced there, but
 *    treated as "nothing to read" rather than a thrown error, consistent
 *    with the rest of this codebase's not_found-is-not-a-failure
 *    convention -- see deleteCanonicalRow.ts).
 */
export async function readVerifiedApplicantData(
  groupId: string,
  passportIdentityId: string,
  deps: ReadVerifiedApplicantDataDependencies = defaultDependencies,
): Promise<VerifiedApplicantData | null> {
  const activeCanonical = await deps.findActiveCanonicalLink(passportIdentityId, groupId);
  if (!activeCanonical) {
    return null;
  }

  const group = await deps.findGroup(groupId);
  if (!group) {
    return null;
  }

  const { spreadsheetId } = await deps.ensureSheet(groupId);
  const sheetTitle =
    group.googleSheetGid !== undefined && group.googleSheetGid !== null
      ? await deps.resolveSheetTitle(spreadsheetId, group.googleSheetGid)
      : undefined;

  const rows = await deps.readClient.getAllDataRows(spreadsheetId, sheetTitle);
  const matchedRow = rows.find((row) => row[12] === activeCanonical.telegramMessageId);
  if (!matchedRow) {
    return null;
  }

  return {
    firstName: cell(matchedRow, 1),
    surname: cell(matchedRow, 2),
    passportNumber: cell(matchedRow, 3),
    dateOfBirth: cell(matchedRow, 4),
    passportIssueDate: cell(matchedRow, 5),
    passportExpiryDate: cell(matchedRow, 6),
    gender: cell(matchedRow, 7),
    nationality: cell(matchedRow, VISA_COLUMN_INDEX.nationality),
    email: cell(matchedRow, VISA_COLUMN_INDEX.email),
    arrivalDate: cell(matchedRow, VISA_COLUMN_INDEX.arrivalDate),
    personalPhotoUrl: cell(matchedRow, VISA_COLUMN_INDEX.personalPhotoUrl),
    passportScanUrl: cell(matchedRow, VISA_COLUMN_INDEX.passportScanUrl),
  };
}
