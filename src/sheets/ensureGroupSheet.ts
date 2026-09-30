import { env } from '../config/env.js';
import { provisionSpreadsheetViaAppsScript, provisionTabViaAppsScript } from './appsScriptProvisioning.js';
import { findGroupById, setGroupGoogleSheetId, setGroupSheetTab, type Group } from '../db/repositories/groups.repo.js';
import { getConfiguredApiTimeoutMs, getConfiguredDriveFolderId, getSheetsClients } from './sheetsAuth.js';
import { headerRangeA1, SHEET_HEADER_ROW } from './sheetLayout.js';

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
  /**
   * `sheetTitle` is additive and optional, same convention as every other
   * tab-aware client in this codebase (see sheetLayout.ts's withSheetTitle):
   * omitted (the legacy, one-file-per-group caller) targets the
   * spreadsheet's own default/first sheet, unchanged. A master/tab caller
   * passes the tab's title so the header lands in that specific tab, never
   * the master spreadsheet's default/first sheet.
   */
  writeHeaderRow(spreadsheetId: string, sheetTitle?: string): Promise<void>;
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
    async writeHeaderRow(spreadsheetId, sheetTitle) {
      const { sheets } = getClients();
      try {
        await sheets.spreadsheets.values.update(
          {
            spreadsheetId,
            range: headerRangeA1(sheetTitle),
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

/**
 * Reads the single, shared master spreadsheet id for the target "one
 * master file, one tab per group" architecture (populated via the Apps
 * Script `ensureTab` action). Optional: when unset — the case for every
 * production flow today, since nothing yet sets this env var — every
 * group, new or existing, falls back entirely to the legacy
 * one-dedicated-file-per-group path below, completely unchanged.
 * Injectable source, same pattern as sheetsAuth.ts's own config resolvers.
 */
export function getConfiguredMasterSpreadsheetId(
  source: { GOOGLE_SHEETS_MASTER_SPREADSHEET_ID?: string } = env,
): string | null {
  return source.GOOGLE_SHEETS_MASTER_SPREADSHEET_ID ?? null;
}

export interface EnsureGroupSheetDependencies {
  findGroup: typeof findGroupById;
  setGoogleSheetId: typeof setGroupGoogleSheetId;
  setGroupSheetTab: typeof setGroupSheetTab;
  provisioningClient: SheetsProvisioningClient;
  provisionTab: typeof provisionTabViaAppsScript;
  /** A function, not a pre-resolved value — only called when a spreadsheet actually needs creating, never on the "already has one" fast path. */
  getDriveFolderId: () => string | null;
  /** A function, not a pre-resolved value — only called for a brand-new group that has no spreadsheet yet. */
  getMasterSpreadsheetId: () => string | null;
}

const defaultDependencies: EnsureGroupSheetDependencies = {
  findGroup: findGroupById,
  setGoogleSheetId: setGroupGoogleSheetId,
  setGroupSheetTab: setGroupSheetTab,
  provisioningClient: buildRealProvisioningClient(),
  provisionTab: provisionTabViaAppsScript,
  getDriveFolderId: getConfiguredDriveFolderId,
  getMasterSpreadsheetId: getConfiguredMasterSpreadsheetId,
};

export interface EnsureGroupSheetResult {
  spreadsheetId: string;
}

/**
 * Returns the group's spreadsheet, creating it once if this is the first
 * time. Never sends the group's passport data anywhere — only the
 * spreadsheet/tab title (built from group.name/departureDate, never
 * passport/OCR content) and the fixed header row (both paths write it now —
 * see ensureGroupTabInMasterSpreadsheet_'s own doc comment for the
 * master/tab path's header-write ordering and idempotency story).
 *
 * Dual-path, dispatched on whether the group already has a google_sheet_id
 * and, for a brand-new group, on whether a master spreadsheet is
 * configured:
 *
 *  - Already has google_sheet_id (legacy dedicated file OR an
 *    already-resolved master+tab — either way this one column is always
 *    the persisted answer): returned immediately, no provisioning call of
 *    any kind. This single check is also what enforces grandfathering — an
 *    existing legacy group is NEVER migrated onto the master architecture,
 *    even once GOOGLE_SHEETS_MASTER_SPREADSHEET_ID is configured, because
 *    it never reaches the branches below that consult it.
 *  - No google_sheet_id yet, master spreadsheet configured: provisions a
 *    tab inside that master file (see ensureGroupTabInMasterSpreadsheet_).
 *  - No google_sheet_id yet, no master spreadsheet configured: the
 *    original, entirely unchanged legacy one-dedicated-file provisioning
 *    path (see ensureLegacyDedicatedSpreadsheet_).
 *
 * Race-safety for the legacy path: groups.repo.ts's setGroupGoogleSheetId
 * only lets ONE racing caller actually persist a google_sheet_id (its
 * UPDATE ... WHERE google_sheet_id IS NULL only matches once) — the single
 * authoritative guard there, unchanged by this stage. (Apps Script's own
 * requestId-keyed lookup adds a second, best-effort layer that often
 * avoids even creating a duplicate file in the first place, but it is an
 * optimization, never something this function relies on for correctness.)
 * The loser's own freshly-created spreadsheet is simply discarded (left as
 * an orphan in Drive — an accepted, documented cost, not retried/deleted:
 * it now lives in a real human's Drive, created via Apps Script, and this
 * service account has at most Editor access to it — neither this backend
 * nor its service account can safely delete a file they do not own, and
 * guessing at deletion risks removing something a human might already be
 * viewing) and it reads back the winner's spreadsheet id instead, so every
 * caller converges on the same one spreadsheet per group regardless of who
 * "won". See ensureGroupTabInMasterSpreadsheet_'s own doc comment for the
 * master/tab path's different, but equally authoritative, race-safety
 * story.
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

  const masterSpreadsheetId = deps.getMasterSpreadsheetId();
  if (masterSpreadsheetId) {
    return ensureGroupTabInMasterSpreadsheet_(group, masterSpreadsheetId, deps);
  }

  return ensureLegacyDedicatedSpreadsheet_(group, groupId, deps);
}

/**
 * New-architecture path for a group with no spreadsheet yet, taken only
 * when GOOGLE_SHEETS_MASTER_SPREADSHEET_ID is configured.
 *
 * Race-safety here comes from a different, but equally authoritative,
 * source than the legacy path's DB-side "claim": the Apps Script
 * `ensureTab` action's own requestId-keyed idempotency and LockService
 * critical section — confirmed safe under genuinely concurrent HTTP
 * requests via real testing, not merely assumed — guarantees that two
 * callers racing with the SAME requestId (here, the group's own id, the
 * same convention the legacy path already uses) always converge on the
 * identical {spreadsheetId, sheetId} pair. setGroupSheetTab's own write is
 * a plain, non-claim-guarded UPDATE (see its own doc comment in
 * groups.repo.ts) precisely because it never has to arbitrate a race
 * itself here — both racing callers write the same already-converged
 * values, so whichever one's UPDATE lands last simply repeats it
 * redundantly, never corrupts it.
 *
 * Writes the header row into the tab using the SAME provisioningClient the
 * legacy path already uses (SheetsProvisioningClient.writeHeaderRow), now
 * tab-aware via its optional sheetTitle parameter — never a separately
 * re-implemented write. Uses tab.title exactly as Apps Script's ensureTab
 * response just returned it: that response IS the live-resolved title at
 * this exact moment, so no extra spreadsheets.get round-trip is needed here
 * (unlike upsertRowInSheet.ts etc., which resolve a PERSISTED gid back to a
 * title long after tab creation and so must always re-resolve it live).
 * Nothing here ever persists tab.title itself — only tab.sheetId is stored,
 * via setGroupSheetTab below.
 *
 * Runs on every call that reaches this function — which, by construction of
 * ensureGroupSheet's own dispatch above, is only ever a group that does NOT
 * yet have google_sheet_id persisted. That is itself the idempotency guard:
 * once setGroupSheetTab below succeeds, this function is never reached
 * again for that group, so the header is never rewritten in steady state.
 * If a previous attempt wrote the header but then failed before persisting
 * (see the throw below), a retry re-enters this same function, calls
 * provisionTab again (idempotent — Apps Script's ensureTab returns the SAME
 * tab, created:false), and rewrites the identical fixed header values —
 * a harmless, idempotent overwrite, not a duplicate write to a different
 * location. If the header write itself throws, it propagates out of this
 * function exactly like any other provisioning failure (same as the legacy
 * path's own unguarded writeHeaderRow call below) — setGroupSheetTab is
 * never reached, so the DB is never marked "done" for a tab whose header
 * write is unconfirmed; a retry starts over from provisionTab.
 */
async function ensureGroupTabInMasterSpreadsheet_(
  group: Group,
  masterSpreadsheetId: string,
  deps: EnsureGroupSheetDependencies,
): Promise<EnsureGroupSheetResult> {
  const tabTitle = buildSpreadsheetTitle(group);
  const tab = await deps.provisionTab({ masterSpreadsheetId, tabTitle, requestId: group.id });

  await deps.provisioningClient.writeHeaderRow(tab.spreadsheetId, tab.title);

  const persisted = await deps.setGroupSheetTab(group.id, tab.spreadsheetId, tab.sheetId);
  if (!persisted) {
    // Apps Script already created/found the tab — never hide this partial
    // state behind a generic failure. A human must reconcile: the tab is
    // real, but the database does not yet know about it.
    throw new Error(
      `ensureGroupSheet: Apps Script ensureTab succeeded for group ${group.id} ` +
        `(spreadsheetId=${tab.spreadsheetId}, sheetId=${tab.sheetId}, title=${tab.title}) ` +
        'but persisting it failed — no matching group row was found to update. ' +
        'The tab now exists in the master spreadsheet but is not recorded in the database; manual reconciliation is required.',
    );
  }
  return { spreadsheetId: persisted.googleSheetId };
}

/** The original one-dedicated-file-per-group path — entirely unchanged behavior, only extracted into its own function so ensureGroupSheet can dispatch to it. */
async function ensureLegacyDedicatedSpreadsheet_(
  group: Group,
  groupId: string,
  deps: EnsureGroupSheetDependencies,
): Promise<EnsureGroupSheetResult> {
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

  // Lost the race — see ensureGroupSheet's doc comment above. No cleanup is
  // attempted here, deliberately: see that doc comment for why deleting
  // the orphan is not a safe operation this backend can perform.
  const winner = await deps.findGroup(groupId);
  if (!winner || !winner.googleSheetId) {
    throw new Error(
      `ensureGroupSheet: lost the sheet-creation race for group ${groupId} but no winning google_sheet_id was found`,
    );
  }
  return { spreadsheetId: winner.googleSheetId };
}
