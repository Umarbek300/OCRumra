import { getConfiguredApiTimeoutMs, getSheetsClients } from './sheetsAuth.js';
import { GENDER_SUMMARY_RANGE } from './genderSummaryLayout.js';

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

/**
 * Overwrites the fixed O1:P5 gender summary block (see
 * genderSummaryLayout.ts) with the given rows. Always a full overwrite of
 * the same fixed range -- never an append, never keyed by any id -- so
 * calling this repeatedly for the same group (retries, later re-syncs)
 * simply re-renders the current truth in place, with nothing to
 * double-write or drift out of sync.
 */
export async function writeGroupGenderSummary(
  spreadsheetId: string,
  rows: readonly (readonly string[])[],
  client: GenderSummaryWriteClient = defaultClient,
): Promise<void> {
  await client.updateRange(spreadsheetId, GENDER_SUMMARY_RANGE, rows);
}
