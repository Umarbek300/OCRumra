/**
 * TEMPORARY ONE-OFF DIAGNOSTIC — not part of the production OCR/Sheets
 * pipeline. Never imported by src/, never wired into any worker.
 *
 * Controlled, single-job, manually-triggered retry of exactly ONE existing,
 * already-'failed' sheet_sync_queue job -- job_id=37c616ad-7548-4748-b174-
 * 35f763b8e084 (telegram_message_id=c1e13e5b-5db9-49e7-919f-6947c82a0f06),
 * the second of the 3 known stale failed jobs from before Apps Script
 * provisioning existed (the first, 8c77e99f-..., was already retried
 * successfully earlier in this session via
 * tmp-diagnostic-retry-job-8c77e99f.ts -- this script is the same pattern
 * applied to the next job).
 *
 * Uses ONLY existing, unmodified production functions
 * (findSheetSyncQueueById, syncPassportRowToSheet, findGroupById) -- no
 * duplicated/new business logic, no changes to any file under src/.
 *
 * SAFETY / SCOPE:
 *  - JOB_ID is hard-coded to 37c616ad-7548-4748-b174-35f763b8e084 only --
 *    no other row in sheet_sync_queue (in particular not
 *    6431e8ac-ac32-4c00-8628-abd5fe0a6614, the remaining 3rd stale job) can
 *    ever be touched by this script.
 *  - STEP 0 (read-only) re-verifies the job still exists and is still
 *    status='failed' before doing anything else; if it is not, the script
 *    stops without calling syncPassportRowToSheet at all.
 *  - DRY RUN BY DEFAULT: everything past STEP 0 only happens if
 *    CONFIRM_E2E_WRITE=yes is set.
 *  - syncPassportRowToSheet's own atomic claim (markSheetSyncStarted:
 *    status IN ('pending','failed') -> 'syncing') is the real guard against
 *    ever double-processing -- this script does not add its own locking.
 *  - Captures the sheet's existing data rows BEFORE the retry so the
 *    already-synced rows (№1, №2, №3) can be diffed against their state
 *    AFTER the retry, to prove they were not touched.
 *  - Never starts runSheetSyncLoop/src/sheets/start.ts, never restarts
 *    ocrumra-worker.service, never reads or changes SHEETS_SYNC_ENABLED,
 *    never calls Tesseract/any OCR provider.
 *  - PRIVACY: never prints the actual passport-derived value of any
 *    visible column (B..L) -- only whether a cell is non-empty. Column A
 *    (№, a row-position integer) and column M (telegram_message_id, a
 *    UUID) are printed in full -- neither is passport PII.
 */
import { pool } from '../src/db/pool.js';
import { findGroupById } from '../src/db/repositories/groups.repo.js';
import { findSheetSyncQueueById } from '../src/db/repositories/sheetSyncQueue.repo.js';
import { getSheetsClients } from '../src/sheets/sheetsAuth.js';
import { FIRST_DATA_ROW_NUMBER, TECHNICAL_ID_COLUMN_LETTER } from '../src/sheets/sheetLayout.js';
import { syncPassportRowToSheet } from '../src/sheets/syncPassportRowToSheet.js';

const GROUP_ID = 'c7e35e47-cb80-4816-abaf-2c96b57fe0d2';
const JOB_ID = '37c616ad-7548-4748-b174-35f763b8e084';
const CONFIRM = process.env.CONFIRM_E2E_WRITE === 'yes';

interface SheetRow {
  numberValue: string | null;
  technicalId: string | null;
}

async function readSheetRows(spreadsheetId: string): Promise<SheetRow[]> {
  const { sheets } = getSheetsClients();
  const range = `A${FIRST_DATA_ROW_NUMBER}:${TECHNICAL_ID_COLUMN_LETTER}`;
  const response = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const rawRows = response.data.values ?? [];
  return rawRows.map((raw) => ({
    numberValue: typeof raw[0] === 'string' && raw[0].length > 0 ? raw[0] : null,
    technicalId: typeof raw[12] === 'string' && raw[12].length > 0 ? raw[12] : null,
  }));
}

async function main(): Promise<void> {
  console.log('[retry-37c616ad] === STEP 0: verify job is still failed (read-only) ===');
  console.log('[retry-37c616ad] job_id:', JOB_ID);

  const before = await findSheetSyncQueueById(JOB_ID);
  if (!before) {
    console.log('[retry-37c616ad] job not found -- stopping.');
    return;
  }
  console.log('[retry-37c616ad] BEFORE: status=%s attempts=%s sheetRowNumber=%s', before.status, before.attempts, before.sheetRowNumber ?? '(null)');
  console.log('[retry-37c616ad] telegram_message_id:', before.telegramMessageId);

  if (before.status !== 'failed') {
    console.log(`[retry-37c616ad] job status is "${before.status}", not "failed" -- stopping, will not touch it.`);
    return;
  }

  const group = await findGroupById(GROUP_ID);
  const spreadsheetId = group?.googleSheetId ?? null;
  if (!spreadsheetId) {
    console.log('[retry-37c616ad] group has no google_sheet_id (unexpected) -- stopping.');
    return;
  }
  console.log('[retry-37c616ad] spreadsheetId:', spreadsheetId);

  const rowsBefore = await readSheetRows(spreadsheetId);
  console.log('[retry-37c616ad] sheet data rows BEFORE retry:', rowsBefore.length);
  rowsBefore.forEach((row, index) => {
    console.log(`[retry-37c616ad]   row index ${index}: №=${row.numberValue ?? '(empty)'} technical_id=${row.technicalId ?? '(empty)'}`);
  });

  if (!CONFIRM) {
    console.log('[retry-37c616ad] DRY RUN (CONFIRM_E2E_WRITE is not "yes") -- stopping here. Nothing was written.');
    console.log('[retry-37c616ad] re-run with CONFIRM_E2E_WRITE=yes to actually retry this one job.');
    return;
  }

  console.log('[retry-37c616ad] === STEP 1: syncPassportRowToSheet (the SAME function the real worker calls) ===');
  await syncPassportRowToSheet(JOB_ID);

  const after = await findSheetSyncQueueById(JOB_ID);
  console.log('[retry-37c616ad] === STEP 2: job status after retry ===');
  console.log('[retry-37c616ad] AFTER: status=%s attempts=%s sheetRowNumber=%s', after?.status, after?.attempts, after?.sheetRowNumber ?? '(null)');

  if (!after || after.status !== 'synced') {
    console.log('[retry-37c616ad] RETRY DID NOT SUCCEED -- stopping before sheet-side checks. Do not touch other jobs.');
    return;
  }

  console.log('[retry-37c616ad] === STEP 3: read the sheet again and verify the new row + unchanged old rows ===');
  const rowsAfter = await readSheetRows(spreadsheetId);
  console.log('[retry-37c616ad] sheet data rows AFTER retry:', rowsAfter.length);
  rowsAfter.forEach((row, index) => {
    console.log(`[retry-37c616ad]   row index ${index}: №=${row.numberValue ?? '(empty)'} technical_id=${row.technicalId ?? '(empty)'}`);
  });

  console.log('[retry-37c616ad] === STEP 4: verification checks ===');
  console.log('[retry-37c616ad]   exactly one new row appended =', rowsAfter.length === rowsBefore.length + 1);

  const newRow = rowsAfter[rowsAfter.length - 1];
  console.log(
    '[retry-37c616ad]   new row\'s technical id (column M) matches this job\'s telegram_message_id =',
    newRow?.technicalId === before.telegramMessageId,
  );

  const oldRowsUnchanged = rowsBefore.every((rowBefore, index) => {
    const rowAfter = rowsAfter[index];
    return rowAfter?.numberValue === rowBefore.numberValue && rowAfter?.technicalId === rowBefore.technicalId;
  });
  console.log('[retry-37c616ad]   previously existing rows (№1, №2, №3) unchanged =', oldRowsUnchanged);

  const allTechnicalIds = rowsAfter.map((r) => r.technicalId).filter((id): id is string => id !== null);
  const uniqueTechnicalIds = new Set(allTechnicalIds);
  console.log('[retry-37c616ad]   no duplicate technical ids across all rows =', uniqueTechnicalIds.size === allTechnicalIds.length);

  console.log('[retry-37c616ad] === STEP 5: final job state ===');
  console.log(
    '[retry-37c616ad]   status=%s (expected "synced")  attempts=%s  sheetRowNumber=%s',
    after.status,
    after.attempts,
    after.sheetRowNumber ?? '(null)',
  );

  console.log('[retry-37c616ad] DONE. Only job_id=' + JOB_ID + ' was touched. Worker was never started; this process ran once and will exit.');
}

main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : 'unknown error';
    console.error('[retry-37c616ad] FAILED:', message.slice(0, 300));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
