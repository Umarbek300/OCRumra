/**
 * TEMPORARY ONE-OFF DIAGNOSTIC — not part of the production OCR/Sheets
 * pipeline. Never imported by src/, never wired into any worker.
 *
 * Preflight check for the Google Sheets/Drive service account, before any
 * real spreadsheet is ever created: confirms authentication actually
 * works, and that the configured Drive folder is reachable by this
 * service account with the right capabilities — using the EXISTING,
 * unmodified production auth code (src/sheets/sheetsAuth.ts's
 * getSheetsClients/getConfiguredDriveFolderId), never a separate or
 * duplicated auth path.
 *
 * READ-ONLY: makes only drive.about.get and drive.files.get calls.
 * Never creates, writes, renames, or modifies any file, folder, or
 * spreadsheet anywhere. Never touches Sheets API at all (no
 * spreadsheets.create/values.*) — this is a Drive/auth check only.
 *
 * SECRET SAFETY: never reads or prints the service-account JSON's
 * private_key (or any field from that file at all — it never opens the
 * file directly, only goes through sheetsAuth.ts's own GoogleAuth flow).
 * Only ever prints what this script's own two read-only Drive API calls
 * return: the service-account's own email (not a secret — needed to
 * confirm which identity is authenticating and to share folders with),
 * and the folder's id/name/mimeType/capability booleans.
 */
import { getConfiguredDriveFolderId, getSheetsClients } from '../src/sheets/sheetsAuth.js';

async function main(): Promise<void> {
  console.log('[sheets-preflight] resolving auth + clients via sheetsAuth.ts (unmodified production code)...');
  const { drive } = getSheetsClients();

  console.log('[sheets-preflight] === 1) WHO IS AUTHENTICATING ===');
  const about = await drive.about.get({ fields: 'user(emailAddress,displayName)' });
  console.log('[sheets-preflight] authenticated as:', about.data.user?.emailAddress ?? '(unknown)');

  console.log('[sheets-preflight] === 2) CONFIGURED DRIVE FOLDER ===');
  const folderId = getConfiguredDriveFolderId();
  if (!folderId) {
    console.log('[sheets-preflight] GOOGLE_SHEETS_DRIVE_FOLDER_ID is not configured -- nothing further to check.');
    return;
  }
  console.log('[sheets-preflight] configured folder id:', folderId);

  const folder = await drive.files.get({
    fileId: folderId,
    fields: 'id, name, mimeType, capabilities(canAddChildren, canEdit)',
  });

  console.log('[sheets-preflight] folder found:', {
    id: folder.data.id,
    name: folder.data.name,
    mimeType: folder.data.mimeType,
    isActuallyAFolder: folder.data.mimeType === 'application/vnd.google-apps.folder',
    canAddChildren: folder.data.capabilities?.canAddChildren ?? null,
    canEdit: folder.data.capabilities?.canEdit ?? null,
  });

  console.log('[sheets-preflight] DONE -- read-only, no spreadsheet or file was created or modified anywhere.');
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : 'unknown error';
  console.error('[sheets-preflight] FAILED:', message.slice(0, 300));
  process.exitCode = 1;
});
