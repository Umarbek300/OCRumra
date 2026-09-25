import { findGroupById, setGroupGoogleSheetId, type Group } from '../db/repositories/groups.repo.js';
import { getConfiguredApiTimeoutMs, getConfiguredDriveFolderId, getSheetsClients } from './sheetsAuth.js';
import { HEADER_RANGE_A1, SHEET_HEADER_ROW } from './sheetLayout.js';

const MAX_TITLE_LENGTH = 200;

/**
 * Pure and side-effect free. Strips embedded newlines/tabs a bad group.name
 * value could contain (never desirable in a Drive file title) and caps
 * length defensively — Drive's own limit is far higher, this is just a
 * sanity bound, not a real-world constraint group names are expected to hit.
 */
export function buildSpreadsheetTitle(group: Pick<Group, 'name' | 'departureDate'>): string {
  const sanitizedName = group.name.replace(/[\r\n\t]+/g, ' ').trim();
  const title = `${sanitizedName} — ${group.departureDate}`;
  return title.length > MAX_TITLE_LENGTH ? title.slice(0, MAX_TITLE_LENGTH) : title;
}

export interface SheetsProvisioningClient {
  createSpreadsheet(title: string): Promise<{ spreadsheetId: string }>;
  writeHeaderRow(spreadsheetId: string): Promise<void>;
  moveToFolder(spreadsheetId: string, folderId: string): Promise<void>;
}

/**
 * Every method below calls getClients() itself, lazily, at call time —
 * never at buildRealProvisioningClient()'s own construction time. That
 * keeps this function safe to call unconditionally when building
 * defaultDependencies (module load time / whenever the default is
 * assembled), even in a test process that never configures
 * GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY_FILE at all, since no method here is
 * ever actually invoked unless a caller really means to hit the real API.
 *
 * getClients defaults to the real getSheetsClients but is overridable —
 * exported (and injectable) purely so a test can verify the timeout option
 * below actually reaches each call's real gaxios request options, using a
 * fake {sheets, drive} pair instead of hitting a real Google account. This
 * never changes what a normal caller (defaultDependencies below) does.
 *
 * Every call passes `{ timeout: getConfiguredApiTimeoutMs() }` as its
 * gaxios request options (the documented way this googleapis client
 * exposes gaxios's own `timeout`, confirmed against this repo's installed
 * gaxios: MethodOptions extends GaxiosOptions, which has `timeout?: number`,
 * internally applied via the native AbortSignal.timeout()) — so a single
 * hung/slow Sheets or Drive call can never block this job (and therefore
 * the whole sync loop, which awaits jobs sequentially) indefinitely. On
 * timeout, the call simply rejects like any other network error; the
 * caller (syncPassportRowToSheet) already treats any rejection here as a
 * normal failure -> markFailed + backoff, nothing timeout-specific needed
 * there.
 */
export function buildRealProvisioningClient(getClients: typeof getSheetsClients = getSheetsClients): SheetsProvisioningClient {
  return {
    async createSpreadsheet(title) {
      const { sheets } = getClients();
      const response = await sheets.spreadsheets.create(
        {
          requestBody: { properties: { title } },
          fields: 'spreadsheetId',
        },
        { timeout: getConfiguredApiTimeoutMs() },
      );
      const spreadsheetId = response.data.spreadsheetId;
      if (!spreadsheetId) {
        throw new Error('Google Sheets did not return a spreadsheetId for the newly created spreadsheet');
      }
      return { spreadsheetId };
    },
    async writeHeaderRow(spreadsheetId) {
      const { sheets } = getClients();
      await sheets.spreadsheets.values.update(
        {
          spreadsheetId,
          range: HEADER_RANGE_A1,
          valueInputOption: 'RAW',
          requestBody: { values: [[...SHEET_HEADER_ROW]] },
        },
        { timeout: getConfiguredApiTimeoutMs() },
      );
    },
    async moveToFolder(spreadsheetId, folderId) {
      const { drive } = getClients();
      const existing = await drive.files.get(
        { fileId: spreadsheetId, fields: 'parents' },
        { timeout: getConfiguredApiTimeoutMs() },
      );
      const previousParents = (existing.data.parents ?? []).join(',');
      await drive.files.update(
        {
          fileId: spreadsheetId,
          addParents: folderId,
          removeParents: previousParents.length > 0 ? previousParents : undefined,
          fields: 'id, parents',
        },
        { timeout: getConfiguredApiTimeoutMs() },
      );
    },
  };
}

export interface EnsureGroupSheetDependencies {
  findGroup: typeof findGroupById;
  setGoogleSheetId: typeof setGroupGoogleSheetId;
  provisioningClient: SheetsProvisioningClient;
  /** A function, not a pre-resolved value — only called when a spreadsheet actually needs creating, never on the "already has one" fast path. */
  getDriveFolderId: () => string | null;
}

const defaultDependencies: EnsureGroupSheetDependencies = {
  findGroup: findGroupById,
  setGoogleSheetId: setGroupGoogleSheetId,
  provisioningClient: buildRealProvisioningClient(),
  getDriveFolderId: getConfiguredDriveFolderId,
};

export interface EnsureGroupSheetResult {
  spreadsheetId: string;
}

/**
 * Returns the group's spreadsheet, creating it once if this is the first
 * time. Never sends the group's passport data anywhere — only the
 * spreadsheet title (built from group.name/departureDate, never
 * passport/OCR content) and the fixed header row.
 *
 * Race-safety: if two callers race to provision the same group's sheet
 * concurrently, groups.repo.ts's setGroupGoogleSheetId only lets ONE of
 * them actually persist a google_sheet_id (its UPDATE ... WHERE
 * google_sheet_id IS NULL only matches once). The loser's own
 * freshly-created spreadsheet is simply discarded (left as an orphan in
 * Drive — an accepted, documented cost, not retried/deleted) and it reads
 * back the winner's spreadsheet id instead, so every caller converges on
 * the same one spreadsheet per group regardless of who "won".
 */
export async function ensureGroupSheet(
  groupId: string,
  deps: EnsureGroupSheetDependencies = defaultDependencies,
): Promise<EnsureGroupSheetResult> {
  const group = await deps.findGroup(groupId);
  if (!group) {
    throw new Error(`ensureGroupSheet: no group found for id ${groupId}`);
  }
  if (group.googleSheetId) {
    return { spreadsheetId: group.googleSheetId };
  }

  const title = buildSpreadsheetTitle(group);
  const { spreadsheetId } = await deps.provisioningClient.createSpreadsheet(title);
  await deps.provisioningClient.writeHeaderRow(spreadsheetId);

  const folderId = deps.getDriveFolderId();
  if (folderId) {
    await deps.provisioningClient.moveToFolder(spreadsheetId, folderId);
  }

  const claimed = await deps.setGoogleSheetId(groupId, spreadsheetId);
  if (claimed && claimed.googleSheetId) {
    return { spreadsheetId: claimed.googleSheetId };
  }

  // Lost the race — see doc comment above.
  const winner = await deps.findGroup(groupId);
  if (!winner || !winner.googleSheetId) {
    throw new Error(
      `ensureGroupSheet: lost the sheet-creation race for group ${groupId} but no winning google_sheet_id was found`,
    );
  }
  return { spreadsheetId: winner.googleSheetId };
}
