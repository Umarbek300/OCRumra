import { getConfiguredApiTimeoutMs, getSheetsClients } from './sheetsAuth.js';
import { withSheetTitle } from './sheetLayout.js';
import { GENDER_SUMMARY_RANGE } from './genderSummaryLayout.js';
import { buildRealSheetTitleResolver, type ResolveSheetTitleByGid } from './upsertRowInSheet.js';

export interface GenderSummaryWriteClient {
  updateRange(spreadsheetId: string, range: string, values: readonly (readonly string[])[]): Promise<void>;
}

/** Same lazy-getClients, timeout-bounded pattern as upsertRowInSheet.ts's buildRealSheetsWriteClient -- see that file's own doc comment for why. */
export function buildRealGenderSummaryWriteClient(getClients: typeof getSheetsClients = getSheetsClients): GenderSummaryWriteClient {
  return {
    async updateRange(spreadsheetId, range, values) {
      const { sheets } = getClients();
      await sheets.spreadsheets.values.update(
        {
          spreadsheetId,
          range,
          valueInputOption: 'RAW',
          requestBody: { values: values.map((row) => [...row]) },
        },
        { timeout: getConfiguredApiTimeoutMs() },
      );
    },
  };
}

const defaultClient: GenderSummaryWriteClient = buildRealGenderSummaryWriteClient();
const defaultResolveSheetTitle: ResolveSheetTitleByGid = buildRealSheetTitleResolver();

/**
 * Overwrites the fixed O1:P5 gender summary block (see
 * genderSummaryLayout.ts) with the given rows. Always a full overwrite of
 * the same fixed range -- never an append, never keyed by any id -- so
 * calling this repeatedly for the same group (retries, later re-syncs)
 * simply re-renders the current truth in place, with nothing to
 * double-write or drift out of sync.
 *
 * Master/tab groups (googleSheetGid set): before writing, resolves that
 * gid's CURRENT tab title live via resolveSheetTitle -- the exact same
 * resolver upsertRowInSheet.ts/deleteRowInSheet.ts/
 * reassignCanonicalRowInSheet.ts already use, never a separately
 * re-implemented lookup -- and prefixes GENDER_SUMMARY_RANGE with it via
 * sheetLayout.ts's own withSheetTitle. An unresolvable gid or a
 * spreadsheets.get failure throws immediately, before any write is ever
 * attempted. Legacy groups (googleSheetGid null/undefined) pass sheetTitle
 * as undefined -- the exact prior behavior (spreadsheetId's own
 * default/first sheet), completely unchanged.
 */
export async function writeGroupGenderSummary(
  spreadsheetId: string,
  rows: readonly (readonly string[])[],
  googleSheetGid?: number | null,
  client: GenderSummaryWriteClient = defaultClient,
  resolveSheetTitle: ResolveSheetTitleByGid = defaultResolveSheetTitle,
): Promise<void> {
  const sheetTitle =
    googleSheetGid !== undefined && googleSheetGid !== null ? await resolveSheetTitle(spreadsheetId, googleSheetGid) : undefined;

  await client.updateRange(spreadsheetId, withSheetTitle(GENDER_SUMMARY_RANGE, sheetTitle), rows);
}
