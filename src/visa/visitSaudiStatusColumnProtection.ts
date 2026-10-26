import { getConfiguredApiTimeoutMs, getSheetsClients } from '../sheets/sheetsAuth.js';

/** A column range on one tab, in the Sheets API's own 0-indexed, end-exclusive GridRange shape. */
export interface SheetGridRange {
  sheetId: number;
  /** 0-indexed, inclusive (A=0, B=1, ..., W=22, ...). */
  startColumnIndex: number;
  /** 0-indexed, EXCLUSIVE -- one past the last protected column, matching the Sheets API's own GridRange convention. */
  endColumnIndex: number;
}

export interface ExistingProtectedRange {
  protectedRangeId: number;
  range: SheetGridRange;
  description?: string;
}

/**
 * The exact description this module writes to, and looks for on a later
 * call -- lets ensureVisaStatusColumnProtected recognize ITS OWN,
 * already-created protection (rather than some unrelated one a human or
 * another feature created) without depending on matching the range alone.
 */
export const VISA_STATUS_PROTECTION_DESCRIPTION = 'OCRumra: VisitSaudi Status (do not edit)';

export interface VisaStatusColumnProtectionClient {
  listProtectedRanges(spreadsheetId: string, sheetId: number): Promise<ExistingProtectedRange[]>;
  addProtectedRange(spreadsheetId: string, range: SheetGridRange, description: string): Promise<ExistingProtectedRange>;
}

/**
 * Real Sheets-API-backed client. listProtectedRanges requests only
 * sheets.properties(sheetId) + sheets.protectedRanges -- never full sheet
 * contents (same minimal-fields convention as upsertRowInSheet.ts's own
 * buildRealSheetTitleResolver). addProtectedRange issues a single
 * batchUpdate addProtectedRange request -- never editors/warningOnly
 * beyond the plain "no editors besides the owner" default, since this
 * module's whole purpose is to block ordinary operator edits to one
 * column, not to manage a list of exceptions.
 */
export function buildRealVisaStatusColumnProtectionClient(
  getClients: typeof getSheetsClients = getSheetsClients,
): VisaStatusColumnProtectionClient {
  return {
    async listProtectedRanges(spreadsheetId, sheetId) {
      const { sheets } = getClients();
      const response = await sheets.spreadsheets.get(
        { spreadsheetId, fields: 'sheets.properties.sheetId,sheets.protectedRanges' },
        { timeout: getConfiguredApiTimeoutMs() },
      );
      const sheet = (response.data.sheets ?? []).find((s) => s.properties?.sheetId === sheetId);
      const ranges = sheet?.protectedRanges ?? [];
      return ranges
        .filter(
          (r) =>
            typeof r.protectedRangeId === 'number' &&
            r.range !== undefined &&
            r.range !== null &&
            typeof r.range.sheetId === 'number',
        )
        .map((r) => ({
          protectedRangeId: r.protectedRangeId as number,
          range: {
            sheetId: r.range!.sheetId as number,
            startColumnIndex: r.range!.startColumnIndex ?? 0,
            endColumnIndex: r.range!.endColumnIndex ?? 0,
          },
          description: r.description ?? undefined,
        }));
    },
    async addProtectedRange(spreadsheetId, range, description) {
      const { sheets } = getClients();
      const response = await sheets.spreadsheets.batchUpdate(
        {
          spreadsheetId,
          requestBody: {
            requests: [
              {
                addProtectedRange: {
                  protectedRange: {
                    range: {
                      sheetId: range.sheetId,
                      startColumnIndex: range.startColumnIndex,
                      endColumnIndex: range.endColumnIndex,
                    },
                    description,
                    warningOnly: false,
                  },
                },
              },
            ],
          },
        },
        { timeout: getConfiguredApiTimeoutMs() },
      );
      const created = response.data.replies?.[0]?.addProtectedRange?.protectedRange;
      if (typeof created?.protectedRangeId !== 'number' || !created.range) {
        throw new Error('addProtectedRange: Sheets API did not return the created protected range');
      }
      return {
        protectedRangeId: created.protectedRangeId,
        range: {
          sheetId: created.range.sheetId ?? range.sheetId,
          startColumnIndex: created.range.startColumnIndex ?? range.startColumnIndex,
          endColumnIndex: created.range.endColumnIndex ?? range.endColumnIndex,
        },
        description: created.description ?? undefined,
      };
    },
  };
}

const defaultClient: VisaStatusColumnProtectionClient = buildRealVisaStatusColumnProtectionClient();

export type EnsureProtectionResult =
  | { ok: true; outcome: 'already-protected' | 'newly-protected'; protectedRangeId: number }
  | { ok: false; reason: 'SHEETS_API_ERROR'; detail: string };

/**
 * Idempotent: checks for an EXISTING protection -- matching both the exact
 * target column range AND this module's own VISA_STATUS_PROTECTION_DESCRIPTION
 * -- before ever creating a new one. Calling this repeatedly (e.g. once per
 * worker startup) never accumulates duplicate protected ranges on the same
 * column, and never mistakes some OTHER, unrelated protected range (a
 * different column, or one without this exact description) for its own.
 * Never silently swallows a Sheets API failure from either the list or the
 * add call -- both are surfaced as `{ ok: false }`, never thrown past this
 * function and never hidden from the caller.
 */
export async function ensureVisaStatusColumnProtected(
  spreadsheetId: string,
  range: SheetGridRange,
  client: VisaStatusColumnProtectionClient = defaultClient,
): Promise<EnsureProtectionResult> {
  let existing: ExistingProtectedRange[];
  try {
    existing = await client.listProtectedRanges(spreadsheetId, range.sheetId);
  } catch (error) {
    return { ok: false, reason: 'SHEETS_API_ERROR', detail: error instanceof Error ? error.message : 'unknown error' };
  }

  const alreadyProtected = existing.find(
    (r) =>
      r.description === VISA_STATUS_PROTECTION_DESCRIPTION &&
      r.range.sheetId === range.sheetId &&
      r.range.startColumnIndex === range.startColumnIndex &&
      r.range.endColumnIndex === range.endColumnIndex,
  );
  if (alreadyProtected) {
    return { ok: true, outcome: 'already-protected', protectedRangeId: alreadyProtected.protectedRangeId };
  }

  try {
    const created = await client.addProtectedRange(spreadsheetId, range, VISA_STATUS_PROTECTION_DESCRIPTION);
    return { ok: true, outcome: 'newly-protected', protectedRangeId: created.protectedRangeId };
  } catch (error) {
    return { ok: false, reason: 'SHEETS_API_ERROR', detail: error instanceof Error ? error.message : 'unknown error' };
  }
}
