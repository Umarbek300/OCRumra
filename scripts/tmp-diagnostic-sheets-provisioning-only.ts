/**
 * TEMPORARY ONE-OFF DIAGNOSTIC — not part of the production OCR/Sheets
 * pipeline. Never imported by src/, never wired into any worker.
 *
 * Tests ONLY the spreadsheet-provisioning path (ensureGroupSheet -> real
 * Apps Script Web App -> service-account verification) for exactly one
 * existing group. Never touches sheet_sync_queue, never calls
 * enqueueSheetSync/syncPassportRowToSheet/upsertRowInSheet, never reads or
 * writes any passport/OCR data, never starts the worker, never reads or
 * changes SHEETS_SYNC_ENABLED.
 *
 * The only production state this writes is: ONE row in `groups`
 * (google_sheet_id for GROUP_ID, via the real, unmodified
 * setGroupGoogleSheetId), and, via the real Apps Script Web App, one new
 * spreadsheet in the human's own Drive (inside the configured
 * GOOGLE_SHEETS_DRIVE_FOLDER_ID). Safety guard: if this group already has
 * a google_sheet_id, it stops without calling ensureGroupSheet again
 * (which would just return the existing id, provisioning nothing new).
 */
import { pool } from '../src/db/pool.js';
import { findGroupById } from '../src/db/repositories/groups.repo.js';
import { ensureGroupSheet } from '../src/sheets/ensureGroupSheet.js';
import { getConfiguredDriveFolderId, getSheetsClients } from '../src/sheets/sheetsAuth.js';

const GROUP_ID = 'c7e35e47-cb80-4816-abaf-2c96b57fe0d2';

async function main(): Promise<void> {
  console.log('[provisioning-only] === STEP 0: current state (read-only) ===');
  const before = await findGroupById(GROUP_ID);
  if (!before) {
    console.log(`[provisioning-only] no group found with id=${GROUP_ID} -- stopping.`);
    return;
  }
  console.log('[provisioning-only] group:', { id: before.id, name: before.name, googleSheetId: before.googleSheetId });

  if (before.googleSheetId) {
    console.log(
      '[provisioning-only] this group already has a google_sheet_id -- stopping without calling ensureGroupSheet ' +
        'again (it would just return the existing id; no new provisioning would happen).',
    );
    return;
  }

  console.log('[provisioning-only] === STEP 1: ensureGroupSheet (real Apps Script provisioning + service-account verification) ===');
  const { spreadsheetId } = await ensureGroupSheet(GROUP_ID);
  console.log('[provisioning-only] spreadsheetId:', spreadsheetId);
  console.log('[provisioning-only] spreadsheet URL (for manual review):', `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`);

  console.log('[provisioning-only] === STEP 2: confirm groups.google_sheet_id was persisted (read-only) ===');
  const after = await findGroupById(GROUP_ID);
  console.log('[provisioning-only] groups.google_sheet_id now:', after?.googleSheetId ?? '(still null -- unexpected)');

  console.log('[provisioning-only] === STEP 3: independent re-verification via the service account (read-only) ===');
  const { drive } = getSheetsClients();
  const folderId = getConfiguredDriveFolderId();
  const fileMeta = await drive.files.get({
    fileId: spreadsheetId,
    fields: 'id, name, mimeType, parents, capabilities(canEdit)',
  });
  console.log('[provisioning-only] file id:', fileMeta.data.id);
  console.log('[provisioning-only] mimeType:', fileMeta.data.mimeType);
  console.log('[provisioning-only] parents:', fileMeta.data.parents, '-- expected folder:', folderId);
  console.log(
    '[provisioning-only] inside configured folder =',
    folderId != null && (fileMeta.data.parents ?? []).includes(folderId),
  );
  console.log('[provisioning-only] service account canEdit =', fileMeta.data.capabilities?.canEdit === true);

  console.log('[provisioning-only] DONE. sheet_sync_queue, passport/OCR data, and the worker were never touched.');
}

main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : 'unknown error';
    console.error('[provisioning-only] FAILED:', message.slice(0, 300));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
