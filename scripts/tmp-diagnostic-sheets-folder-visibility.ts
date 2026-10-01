/**
 * TEMPORARY ONE-OFF DIAGNOSTIC — not part of the production OCR/Sheets
 * pipeline. Never imported by src/, never wired into any worker.
 *
 * Follow-up to tmp-diagnostic-sheets-preflight.ts: that script confirmed
 * service-account authentication works (via the existing, unmodified
 * src/sheets/sheetsAuth.ts) but drive.files.get() on the configured
 * GOOGLE_SHEETS_DRIVE_FOLDER_ID returned "File not found" even though the
 * folder was reportedly shared with this exact service account.
 *
 * This narrows down *why*, without ever writing/creating/renaming anything
 * and without changing any production file, env var, or scope:
 *
 *   A) Re-checks drive.files.get on the configured folder id using the
 *      EXISTING production client (sheetsAuth.ts's getSheetsClients(),
 *      unmodified drive.file scope) — with supportsAllDrives:true, to rule
 *      out a Shared Drive visibility quirk under the current scope.
 *   B) Builds a SEPARATE, diagnostic-only GoogleAuth client from the same
 *      key file (path resolved via sheetsAuth.ts's own
 *      resolveSheetsAuthConfig — no new/duplicated credential handling)
 *      but with the broader, still strictly read-only drive.readonly
 *      scope. Local to this script only — never touches production code
 *      or the cached production client.
 *   C) Under that read-only client: re-tries files.get on the folder id
 *      (with supportsAllDrives:true), lists Shared Drives the service
 *      account belongs to (drives.list), and lists every folder visible to
 *      the service account across My Drive + all Shared Drives
 *      (files.list, mimeType='application/vnd.google-apps.folder',
 *      supportsAllDrives + includeItemsFromAllDrives + corpora:'allDrives'),
 *      printing only id/name/mimeType/driveId for each.
 *
 * READ-ONLY: every call here is a *.get or *.list — nothing is created,
 * modified, renamed, or deleted anywhere, on any drive. drive.readonly is
 * literally incapable of writing via the Drive API.
 *
 * SECRET SAFETY: never reads/prints the key file's private_key or any
 * other field from it directly — always goes through GoogleAuth's own
 * flow. Only ever prints Drive API response metadata (ids, names,
 * mimeTypes, driveIds, capability booleans) plus bounded error messages.
 */
import { google, type drive_v3 } from 'googleapis';
import { getConfiguredDriveFolderId, getSheetsClients, resolveSheetsAuthConfig } from '../src/sheets/sheetsAuth.js';

const MAX_ERROR_LENGTH = 300;
const MAX_FOLDERS_TO_PRINT = 100;

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined;
  const prefix = code !== undefined ? `code=${String(code)} ` : '';
  return `${prefix}${message.slice(0, MAX_ERROR_LENGTH)}`;
}

function summarizeFolder(file: drive_v3.Schema$File): Record<string, unknown> {
  return { id: file.id, name: file.name, mimeType: file.mimeType, driveId: file.driveId ?? null };
}

async function main(): Promise<void> {
  const folderId = getConfiguredDriveFolderId();
  if (!folderId) {
    console.log('[sheets-folder-diag] GOOGLE_SHEETS_DRIVE_FOLDER_ID is not configured -- nothing to check.');
    return;
  }
  console.log('[sheets-folder-diag] target folder id:', folderId);

  console.log('[sheets-folder-diag] === A) production client (drive.file scope), files.get + supportsAllDrives ===');
  const { drive: prodDrive } = getSheetsClients();
  try {
    const result = await prodDrive.files.get({
      fileId: folderId,
      supportsAllDrives: true,
      fields: 'id, name, mimeType, driveId, capabilities(canAddChildren, canEdit)',
    });
    console.log('[sheets-folder-diag] A) FOUND via production (drive.file) scope:', summarizeFolder(result.data));
  } catch (error) {
    console.log('[sheets-folder-diag] A) NOT FOUND via production (drive.file) scope:', describeError(error));
  }

  console.log('[sheets-folder-diag] === B) building a SEPARATE diagnostic-only client, drive.readonly scope ===');
  const { keyFilePath } = resolveSheetsAuthConfig();
  const readonlyAuth = new google.auth.GoogleAuth({
    keyFile: keyFilePath,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });
  const readonlyDrive = google.drive({ version: 'v3', auth: readonlyAuth });

  console.log('[sheets-folder-diag] === C1) drive.readonly: files.get + supportsAllDrives on target folder ===');
  try {
    const result = await readonlyDrive.files.get({
      fileId: folderId,
      supportsAllDrives: true,
      fields: 'id, name, mimeType, driveId, capabilities(canAddChildren, canEdit)',
    });
    console.log('[sheets-folder-diag] C1) FOUND via drive.readonly scope:', summarizeFolder(result.data));
  } catch (error) {
    console.log('[sheets-folder-diag] C1) NOT FOUND via drive.readonly scope either:', describeError(error));
  }

  console.log('[sheets-folder-diag] === C2) drive.readonly: Shared Drives this service account belongs to ===');
  try {
    const sharedDrives = await readonlyDrive.drives.list({ pageSize: 50, fields: 'drives(id, name)' });
    const drives = sharedDrives.data.drives ?? [];
    if (drives.length === 0) {
      console.log('[sheets-folder-diag] C2) no Shared Drives -- service account is not a member of any.');
    } else {
      console.log(`[sheets-folder-diag] C2) ${drives.length} Shared Drive(s):`, drives.map((d) => ({ id: d.id, name: d.name })));
    }
  } catch (error) {
    console.log('[sheets-folder-diag] C2) drives.list failed:', describeError(error));
  }

  console.log('[sheets-folder-diag] === C3) drive.readonly: all folders visible to this service account (My Drive + all Shared Drives) ===');
  try {
    const listResult = await readonlyDrive.files.list({
      q: "mimeType = 'application/vnd.google-apps.folder' and trashed = false",
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      corpora: 'allDrives',
      pageSize: MAX_FOLDERS_TO_PRINT,
      fields: 'files(id, name, mimeType, driveId)',
    });
    const folders = listResult.data.files ?? [];
    console.log(`[sheets-folder-diag] C3) ${folders.length} folder(s) visible (capped at ${MAX_FOLDERS_TO_PRINT}):`);
    for (const folder of folders) {
      const isTarget = folder.id === folderId;
      console.log(`[sheets-folder-diag]   ${isTarget ? '>>> MATCHES TARGET ID <<<' : '-'}`, summarizeFolder(folder));
    }
    if (!folders.some((f) => f.id === folderId)) {
      console.log('[sheets-folder-diag] C3) target folder id NOT present among visible folders.');
    }
  } catch (error) {
    console.log('[sheets-folder-diag] C3) files.list failed:', describeError(error));
  }

  console.log('[sheets-folder-diag] DONE -- read-only, nothing was created, modified, or deleted anywhere.');
}

main().catch((error) => {
  console.error('[sheets-folder-diag] FAILED:', describeError(error));
  process.exitCode = 1;
});
