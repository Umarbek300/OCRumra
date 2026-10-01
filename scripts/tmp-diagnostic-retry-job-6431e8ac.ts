/**
 * TEMPORARY ONE-OFF DIAGNOSTIC — not part of the production OCR/Sheets
 * pipeline. Never imported by src/, never wired into any worker.
 *
 * Controlled, single-job, manually-triggered retry of exactly ONE existing,
 * already-'failed' sheet_sync_queue job -- job_id=6431e8ac-ac32-4c00-8628-
 * abd5fe0a6614 (telegram_message_id=4d1a8bec-8afe-41ad-9952-7b12d50b5ece),
 * the third and last of the 3 known stale failed jobs from before Apps
 * Script provisioning existed (the other two, 8c77e99f-... and
 * 37c616ad-..., were already retried successfully earlier in this session
 * via the same pattern).
 *
 * Uses ONLY existing, unmodified production functions
 * (findSheetSyncQueueById, syncPassportRowToSheet, findGroupById) -- no
 * duplicated/new business logic, no changes to any file under src/.
 *
 * SAFETY / SCOPE:
 *  - JOB_ID is hard-coded to 6431e8ac-ac32-4c00-8628-abd5fe0a6614 only.
 *  - STEP 0 (read-only) re-verifies the job still exists and is still
 *    status='failed' before doing anything else; if it is not, the script
 *    stops without calling syncPassportRowToSheet at all.
 *  - DRY RUN BY DEFAULT: everything past STEP 0 only happens if
 *    CONFIRM_E2E_WRITE=yes is set.
 *  - syncPassportRowToSheet's own atomic claim (markSheetSyncStarted:
 *    status IN ('pending','failed') -> 'syncing') is the real guard against
 *    ever double-processing -- this script does not add its own locking.
 *  - Captures the sheet's existing data rows BEFORE the retry so the
 *    already-synced rows (№1..№4) can be diffed against their state AFTER
 *    the retry, to prove they were not touched.
 *  - Captures every OTHER sheet_sync_queue row's own (status, attempts,
 *    sheet_row_number) BEFORE the retry and re-checks them AFTER, to prove
 *    no other job in the whole table was touched by this run.
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
const JOB_ID = '6431e8ac-ac32-4c00-8628-abd5fe0a6614';
const EXPECTED_TELEGRAM_MESSAGE_ID = '4d1a8bec-8afe-41ad-9952-7b12d50b5ece';
const CONFIRM = process.env.CONFIRM_E2E_WRITE === 'yes';

interface SheetRow {
  numberValue: string | null;
  technicalId: string | null;
}

interface OtherJobSnapshot {
  id: string;
  status: string;
  attempts: number;
  sheet_row_number: number | null;
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

async function readOtherJobs(): Promise<OtherJobSnapshot[]> {
  const { rows } = await pool.query<OtherJobSnapshot>(
    `SELECT id, status, attempts, sheet_row_number FROM sheet_sync_queue WHERE id != $1 ORDER BY id`,
    [JOB_ID],
  );
  return rows;
}

async function main(): Promise<void> {
  console.log('[retry-6431e8ac] === STEP 0: verify job is still failed (read-only) ===');
  console.log('[retry-6431e8ac] job_id:', JOB_ID);

  const before = await findSheetSyncQueueById(JOB_ID);
  if (!before) {
    console.log('[retry-6431e8ac] job not found -- stopping.');
    return;
  }
  console.log('[retry-6431e8ac] BEFORE: status=%s attempts=%s sheetRowNumber=%s', before.status, before.attempts, before.sheetRowNumber ?? '(null)');
  console.log('[retry-6431e8ac] telegram_message_id:', before.telegramMessageId);
  console.log('[retry-6431e8ac] telegram_message_id matches expected:', before.telegramMessageId === EXPECTED_TELEGRAM_MESSAGE_ID);

  if (before.status !== 'failed') {
    console.log(`[retry-6431e8ac] job status is "${before.status}", not "failed" -- stopping, will not touch it.`);
    return;
  }

  const group = await findGroupById(GROUP_ID);
  const spreadsheetId = group?.googleSheetId ?? null;
  if (!spreadsheetId) {
    console.log('[retry-6431e8ac] group has no google_sheet_id (unexpected) -- stopping.');
    return;
  }
  console.log('[retry-6431e8ac] spreadsheetId:', spreadsheetId);

  const rowsBefore = await readSheetRows(spreadsheetId);
  console.log('[retry-6431e8ac] sheet data rows BEFORE retry:', rowsBefore.length);
  rowsBefore.forEach((row, index) => {
    console.log(`[retry-6431e8ac]   row index ${index}: №=${row.numberValue ?? '(empty)'} technical_id=${row.technicalId ?? '(empty)'}`);
  });

  const otherJobsBefore = await readOtherJobs();
  console.log('[retry-6431e8ac] other sheet_sync_queue jobs BEFORE retry:', otherJobsBefore.length);

  if (!CONFIRM) {
    console.log('[retry-6431e8ac] DRY RUN (CONFIRM_E2E_WRITE is not "yes") -- stopping here. Nothing was written.');
    console.log('[retry-6431e8ac] re-run with CONFIRM_E2E_WRITE=yes to actually retry this one job.');
    return;
  }

  console.log('[retry-6431e8ac] === STEP 1: syncPassportRowToSheet (the SAME function the real worker calls) ===');
  await syncPassportRowToSheet(JOB_ID);

  const after = await findSheetSyncQueueById(JOB_ID);
  console.log('[retry-6431e8ac] === STEP 2: job status after retry ===');
  console.log('[retry-6431e8ac] AFTER: status=%s attempts=%s sheetRowNumber=%s', after?.status, after?.attempts, after?.sheetRowNumber ?? '(null)');

  if (!after || after.status !== 'synced') {
    console.log('[retry-6431e8ac] RETRY DID NOT SUCCEED -- stopping before sheet-side checks. Do not touch other jobs.');
    return;
  }

  console.log('[retry-6431e8ac] === STEP 3: read the sheet again and verify the new row + unchanged old rows ===');
  const rowsAfter = await readSheetRows(spreadsheetId);
  console.log('[retry-6431e8ac] sheet data rows AFTER retry:', rowsAfter.length);
  rowsAfter.forEach((row, index) => {
    console.log(`[retry-6431e8ac]   row index ${index}: №=${row.numberValue ?? '(empty)'} technical_id=${row.technicalId ?? '(empty)'}`);
  });

  console.log('[retry-6431e8ac] === STEP 4: verification checks ===');
  console.log('[retry-6431e8ac]   exactly one new row appended =', rowsAfter.length === rowsBefore.length + 1);

  const newRow = rowsAfter[rowsAfter.length - 1];
  console.log(
    '[retry-6431e8ac]   new row\'s technical id (column M) matches this job\'s telegram_message_id =',
    newRow?.technicalId === before.telegramMessageId,
  );
  console.log('[retry-6431e8ac]   new row\'s № =', newRow?.numberValue ?? '(empty)');

  const oldRowsUnchanged = rowsBefore.every((rowBefore, index) => {
    const rowAfter = rowsAfter[index];
    return rowAfter?.numberValue === rowBefore.numberValue && rowAfter?.technicalId === rowBefore.technicalId;
  });
  console.log('[retry-6431e8ac]   previously existing rows (№1..№4) unchanged =', oldRowsUnchanged);

  const allTechnicalIds = rowsAfter.map((r) => r.technicalId).filter((id): id is string => id !== null);
  const uniqueTechnicalIds = new Set(allTechnicalIds);
  console.log('[retry-6431e8ac]   no duplicate technical ids across all rows =', uniqueTechnicalIds.size === allTechnicalIds.length);

  console.log('[retry-6431e8ac] === STEP 5: confirm no other sheet_sync_queue job was touched ===');
  const otherJobsAfter = await readOtherJobs();
  const otherJobsUnchanged =
    otherJobsAfter.length === otherJobsBefore.length &&
    otherJobsBefore.every((jobBefore, index) => {
      const jobAfter = otherJobsAfter[index];
      return (
        jobAfter?.id === jobBefore.id &&
        jobAfter?.status === jobBefore.status &&
        jobAfter?.attempts === jobBefore.attempts &&
        jobAfter?.sheet_row_number === jobBefore.sheet_row_number
      );
    });
  console.log('[retry-6431e8ac]   all other sheet_sync_queue jobs unchanged =', otherJobsUnchanged, `(${otherJobsAfter.length} other jobs checked)`);

  console.log('[retry-6431e8ac] === STEP 6: final job state ===');
  console.log(
    '[retry-6431e8ac]   status=%s (expected "synced")  attempts=%s  sheetRowNumber=%s',
    after.status,
    after.attempts,
    after.sheetRowNumber ?? '(null)',
  );

  console.log('[retry-6431e8ac] DONE. Only job_id=' + JOB_ID + ' was touched. Worker was never started; this process ran once and will exit.');
}

main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : 'unknown error';
    console.error('[retry-6431e8ac] FAILED:', message.slice(0, 300));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
