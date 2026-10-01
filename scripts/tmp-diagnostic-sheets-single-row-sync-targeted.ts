/**
 * TEMPORARY ONE-OFF DIAGNOSTIC — not part of the production OCR/Sheets
 * pipeline. Never imported by src/, never wired into any worker.
 *
 * Targeted variant of tmp-diagnostic-sheets-single-row-sync.ts: instead of
 * picking "the most recent no-queue-row message" in the group, this script
 * hard-codes the exact telegram_message_id already confirmed clean by
 * tmp-diagnostic-remaining-candidates-queue-check.ts --
 * telegram_message_id=92d36381-8450-40f4-a5ef-a8c79b1335e9
 * (ocr_result_id=88b3e185-93f0-4fca-bf8d-da1a59658541, provider=google-vision,
 * overall_confidence=medium, all 7 core fields non-null, no pre-existing
 * sheet_sync_queue job) -- so this run cannot silently land on a different
 * message than the one already reviewed.
 *
 * Uses ONLY existing, unmodified production functions (enqueueSheetSync,
 * findSheetSyncQueueById, syncPassportRowToSheet, findGroupById,
 * buildRealSheetsWriteClient) -- no duplicated/new business logic, no
 * changes to any file under src/.
 *
 * SAFETY / SCOPE:
 *  - GROUP_ID is hard-coded to c7e35e47-cb80-4816-abaf-2c96b57fe0d2 only --
 *    no other group can ever be touched by this script.
 *  - TARGET_TELEGRAM_MESSAGE_ID is hard-coded to the one confirmed clean
 *    candidate. STEP 0 (read-only) re-verifies, at run time, that this exact
 *    message: (a) belongs to GROUP_ID, (b) has a passport_ocr_results row,
 *    and (c) still has no sheet_sync_queue row -- if any check fails, the
 *    script stops before doing anything else.
 *  - DRY RUN BY DEFAULT: everything past STEP 0 only happens if
 *    CONFIRM_E2E_WRITE=yes is set. The dry-run output prints only the
 *    group id, the target telegram_message_id, and its passport_ocr_results
 *    row's own internal id -- never any passport field (name, passport
 *    number, dates, gender, etc.).
 *  - Confirmed mode creates exactly ONE sheet_sync_queue job (via the real
 *    enqueueSheetSync) and syncs exactly that one message (via the real
 *    syncPassportRowToSheet) -- never touches any other row.
 *  - Idempotency check re-syncs the SAME job and compares the technical-id
 *    (column M) row COUNT before/after, and the recorded sheet row number
 *    before/after -- never prints the actual passport data written to any
 *    visible column.
 *  - Never starts runSheetSyncLoop/src/sheets/start.ts, never reads or
 *    changes SHEETS_SYNC_ENABLED, never deletes the spreadsheet, never
 *    calls Tesseract/any OCR provider (the passport_ocr_results row it
 *    uses must already exist).
 */
import { pool } from '../src/db/pool.js';
import { findGroupById } from '../src/db/repositories/groups.repo.js';
import { enqueueSheetSync, findSheetSyncQueueById } from '../src/db/repositories/sheetSyncQueue.repo.js';
import { syncPassportRowToSheet } from '../src/sheets/syncPassportRowToSheet.js';
import { buildRealSheetsWriteClient } from '../src/sheets/upsertRowInSheet.js';

const GROUP_ID = 'c7e35e47-cb80-4816-abaf-2c96b57fe0d2';
const TARGET_TELEGRAM_MESSAGE_ID = '92d36381-8450-40f4-a5ef-a8c79b1335e9';
const CONFIRM = process.env.CONFIRM_E2E_WRITE === 'yes';

interface Candidate {
  telegramMessageId: string;
  ocrResultId: string;
}

async function verifyTarget(): Promise<Candidate | null> {
  const { rows } = await pool.query<{ telegram_message_id: string; ocr_result_id: string; has_queue_job: boolean }>(
    `SELECT
       tm.id AS telegram_message_id,
       por.id AS ocr_result_id,
       (ssq.id IS NOT NULL) AS has_queue_job
     FROM telegram_messages tm
     JOIN passport_ocr_results por ON por.telegram_message_id = tm.id
     LEFT JOIN sheet_sync_queue ssq ON ssq.telegram_message_id = tm.id
     WHERE tm.id = $1 AND tm.group_id = $2`,
    [TARGET_TELEGRAM_MESSAGE_ID, GROUP_ID],
  );
  const row = rows[0];
  if (!row) {
    console.log('[targeted-single-row-sync] target message not found in this group, or has no passport_ocr_results row -- stopping.');
    return null;
  }
  if (row.has_queue_job) {
    console.log('[targeted-single-row-sync] target message already has a sheet_sync_queue row -- stopping (this script must not touch it).');
    return null;
  }
  return { telegramMessageId: row.telegram_message_id, ocrResultId: row.ocr_result_id };
}

async function main(): Promise<void> {
  console.log('[targeted-single-row-sync] === STEP 0: verify the hard-coded target is still clean (read-only) ===');
  console.log('[targeted-single-row-sync] group_id:', GROUP_ID);
  console.log('[targeted-single-row-sync] target telegram_message_id:', TARGET_TELEGRAM_MESSAGE_ID);

  const candidate = await verifyTarget();
  if (!candidate) return;
  console.log('[targeted-single-row-sync] verified ocr_result internal id (not passport data):', candidate.ocrResultId);

  if (!CONFIRM) {
    console.log('[targeted-single-row-sync] DRY RUN (CONFIRM_E2E_WRITE is not "yes") -- stopping here. Nothing was written.');
    console.log('[targeted-single-row-sync] re-run with CONFIRM_E2E_WRITE=yes to enqueue + sync this one message.');
    return;
  }

  console.log('[targeted-single-row-sync] === STEP 1: enqueueSheetSync (real production function, one INSERT) ===');
  const job = await enqueueSheetSync(candidate.telegramMessageId);
  if (!job) {
    console.log('[targeted-single-row-sync] enqueueSheetSync returned null (a job already existed) -- stopping, not touching it.');
    return;
  }
  console.log('[targeted-single-row-sync] job created:', { id: job.id, status: job.status, attempts: job.attempts });

  console.log('[targeted-single-row-sync] === STEP 2: syncPassportRowToSheet (the SAME function the real worker calls) ===');
  await syncPassportRowToSheet(job.id);

  const afterFirstSync = await findSheetSyncQueueById(job.id);
  if (!afterFirstSync || afterFirstSync.status !== 'synced') {
    console.log('[targeted-single-row-sync] SYNC DID NOT SUCCEED -- stopping before the idempotency check:', afterFirstSync);
    return;
  }
  console.log('[targeted-single-row-sync] job synced:', {
    status: afterFirstSync.status,
    attempts: afterFirstSync.attempts,
    sheetRowNumber: afterFirstSync.sheetRowNumber,
  });

  const group = await findGroupById(GROUP_ID);
  const spreadsheetId = group?.googleSheetId ?? null;
  if (!spreadsheetId) {
    console.log('[targeted-single-row-sync] FAILED -- group has no google_sheet_id (unexpected; it should already have one).');
    return;
  }
  console.log('[targeted-single-row-sync] spreadsheetId:', spreadsheetId);
  console.log(
    '[targeted-single-row-sync] spreadsheet URL (for manual review):',
    `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
  );

  console.log('[targeted-single-row-sync] === STEP 3: idempotency -- re-sync the SAME job, expect no duplicate row ===');
  const writeClient = buildRealSheetsWriteClient();
  const idColumnBefore = await writeClient.getTechnicalIdColumn(spreadsheetId);
  console.log('[targeted-single-row-sync] technical-id (column M) row count before re-sync:', idColumnBefore.length);

  await pool.query(`UPDATE sheet_sync_queue SET status = 'pending', next_attempt_at = now() WHERE id = $1`, [job.id]);
  await syncPassportRowToSheet(job.id);

  const afterSecondSync = await findSheetSyncQueueById(job.id);
  console.log('[targeted-single-row-sync] job after second sync:', {
    status: afterSecondSync?.status,
    attempts: afterSecondSync?.attempts,
    sheetRowNumber: afterSecondSync?.sheetRowNumber,
  });

  const idColumnAfter = await writeClient.getTechnicalIdColumn(spreadsheetId);
  console.log('[targeted-single-row-sync] technical-id (column M) row count after re-sync:', idColumnAfter.length);
  console.log(
    '[targeted-single-row-sync] STEP 3 result: no duplicate row appended =',
    idColumnAfter.length === idColumnBefore.length,
  );
  console.log(
    '[targeted-single-row-sync] STEP 3 result: sheet row number unchanged across both syncs =',
    afterFirstSync.sheetRowNumber === afterSecondSync?.sheetRowNumber,
  );

  console.log('[targeted-single-row-sync] DONE. Worker was never started; this process ran once and will exit.');
}

main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : 'unknown error';
    console.error('[targeted-single-row-sync] FAILED:', message.slice(0, 300));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
