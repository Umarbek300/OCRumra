import { provisionSpreadsheetViaAppsScript } from './appsScriptProvisioning.js';
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
  createSpreadsheet(title: string, requestId: string, folderId: string): Promise<{ spreadsheetId: string }>;
  writeHeaderRow(spreadsheetId: string): Promise<void>;
  /**
   * Retained as a real, working capability and for test/interface
   * compatibility — but no longer called from ensureGroupSheet's own
   * provisioning flow below: createSpreadsheet above now provisions the
   * file via Apps Script already placed inside the target folder (see its
   * own doc comment), and verifies that placement before returning, so a
   * second, redundant move is unnecessary there.
   */
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
 * provision defaults to the real provisionSpreadsheetViaAppsScript, same
 * injectability reason.
 *
 * Every Sheets/Drive call passes `{ timeout: getConfiguredApiTimeoutMs() }`
 * as its gaxios request options (the documented way this googleapis client
 * exposes gaxios's own `timeout`, confirmed against this repo's installed
 * gaxios: MethodOptions extends GaxiosOptions, which has `timeout?: number`,
 * internally applied via the native AbortSignal.timeout()) — so a single
 * hung/slow Sheets or Drive call can never block this job (and therefore
 * the whole sync loop, which awaits jobs sequentially) indefinitely. On
 * timeout, the call simply rejects like any other network error; the
 * caller (syncPassportRowToSheet) already treats any rejection here as a
 * normal failure -> markFailed + backoff, nothing timeout-specific needed
 * there. provisionSpreadsheetViaAppsScript applies the same timeout to its
 * own HTTP call independently (see its own doc comment).
 */
export function buildRealProvisioningClient(
  getClients: typeof getSheetsClients = getSheetsClients,
  provision: typeof provisionSpreadsheetViaAppsScript = provisionSpreadsheetViaAppsScript,
): SheetsProvisioningClient {
  return {
    /**
     * A plain service account (no Google Workspace domain-wide delegation)
     * has zero Drive storage quota of its own, so it cannot create a new
     * file directly (confirmed via production diagnostics: a bare
     * sheets.spreadsheets.create() call fails with "The caller does not
     * have permission"). Provisioning instead goes through an Apps Script
     * Web App bound to a real Google account (see appsScriptProvisioning.ts),
     * which creates the spreadsheet under that account's own quota,
     * already placed inside the target Drive folder.
     *
     * Once Apps Script returns a spreadsheetId, this verifies — using the
     * service account, which only needs read access for this check — that
     * the file it was handed is real and usable: it exists, is actually a
     * spreadsheet, sits inside the expected folder, and the service
     * account itself has edit access to it (whether via the folder's own
     * permission inheritance or Apps Script's addEditor fallback — either
     * way, this check is the actual source of truth, not an assumption).
     * Any mismatch throws, which syncPassportRowToSheet's existing
     * try/catch already turns into a normal markFailed + backoff, same as
     * any other provisioning failure.
     */
    async createSpreadsheet(title, requestId, folderId) {
      const { spreadsheetId } = await provision({ title, folderId, requestId });

      const { drive } = getClients();
      const verification = await (async () => {
        try {
          return await drive.files.get(
            { fileId: spreadsheetId, fields: 'id, mimeType, parents, capabilities(canEdit)' },
            { timeout: getConfiguredApiTimeoutMs() },
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : 'unknown error';
          throw new Error(`Apps Script provisioning verification (drive.files.get) failed: ${message.slice(0, 300)}`);
        }
      })();

      if (verification.data.id !== spreadsheetId) {
        throw new Error(`Apps Script returned spreadsheetId ${spreadsheetId} but the service account could not verify its id`);
      }
      if (verification.data.mimeType !== 'application/vnd.google-apps.spreadsheet') {
        throw new Error(
          `Apps Script returned spreadsheetId ${spreadsheetId} but it is not a spreadsheet (mimeType=${verification.data.mimeType})`,
        );
      }
      if (!(verification.data.parents ?? []).includes(folderId)) {
        throw new Error(`Apps Script returned spreadsheetId ${spreadsheetId} but it is not inside the configured Drive folder`);
      }
      if (verification.data.capabilities?.canEdit !== true) {
        throw new Error(`Apps Script returned spreadsheetId ${spreadsheetId} but the service account does not have edit access to it`);
      }

      return { spreadsheetId };
    },
    async writeHeaderRow(spreadsheetId) {
      const { sheets } = getClients();
      try {
        await sheets.spreadsheets.values.update(
          {
            spreadsheetId,
            range: HEADER_RANGE_A1,
            valueInputOption: 'RAW',
            requestBody: { values: [[...SHEET_HEADER_ROW]] },
          },
          { timeout: getConfiguredApiTimeoutMs() },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown error';
        throw new Error(`writeHeaderRow (spreadsheets.values.update) failed: ${message.slice(0, 300)}`);
      }
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
 * google_sheet_id IS NULL only matches once) — this is the single
 * authoritative guard, unchanged by Apps Script provisioning. (Apps
 * Script's own requestId-keyed lookup adds a second, best-effort layer
 * that often avoids even creating a duplicate file in the first place, but
 * it is an optimization, never something this function relies on for
 * correctness.) The loser's own freshly-created spreadsheet is simply
 * discarded (left as an orphan in Drive — an accepted, documented cost,
 * not retried/deleted: it now lives in a real human's Drive, created via
 * Apps Script, and this service account has at most Editor access to it —
 * neither this backend nor its service account can safely delete a file
 * they do not own, and guessing at deletion risks removing something a
 * human might already be viewing) and it reads back the winner's
 * spreadsheet id instead, so every caller converges on the same one
 * spreadsheet per group regardless of who "won".
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

  const folderId = deps.getDriveFolderId();
  if (!folderId) {
    throw new Error(
      'ensureGroupSheet: GOOGLE_SHEETS_DRIVE_FOLDER_ID is not configured — cannot provision a new spreadsheet ' +
        '(Apps Script provisioning requires a target Drive folder).',
    );
  }

  const title = buildSpreadsheetTitle(group);
  const { spreadsheetId } = await deps.provisioningClient.createSpreadsheet(title, groupId, folderId);
  await deps.provisioningClient.writeHeaderRow(spreadsheetId);

  const claimed = await deps.setGoogleSheetId(groupId, spreadsheetId);
  if (claimed && claimed.googleSheetId) {
    return { spreadsheetId: claimed.googleSheetId };
  }

  // Lost the race — see doc comment above. No cleanup is attempted here,
  // deliberately: see the doc comment for why deleting the orphan is not a
  // safe operation this backend can perform.
  const winner = await deps.findGroup(groupId);
  if (!winner || !winner.googleSheetId) {
    throw new Error(
      `ensureGroupSheet: lost the sheet-creation race for group ${groupId} but no winning google_sheet_id was found`,
    );
  }
  return { spreadsheetId: winner.googleSheetId };
}
