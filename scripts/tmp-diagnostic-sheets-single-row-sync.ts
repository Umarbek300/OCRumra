/**
 * TEMPORARY ONE-OFF DIAGNOSTIC — not part of the production OCR/Sheets
 * pipeline. Never imported by src/, never wired into any worker.
 *
 * Tests writing exactly ONE existing OCR result into the ALREADY-
 * PROVISIONED, already-verified spreadsheet for group c7e35e47 — i.e. the
 * "existing spreadsheet" fast path of ensureGroupSheet, followed by
 * upsertRowInSheet, which the earlier provisioning-only diagnostic never
 * exercised (that one only tested spreadsheet CREATION).
 *
 * Uses ONLY existing, unmodified production functions (enqueueSheetSync,
 * findSheetSyncQueueById, syncPassportRowToSheet, findGroupById,
 * buildRealSheetsWriteClient) — no duplicated/new business logic, no
 * changes to any file under src/.
 *
 * SAFETY / SCOPE:
 *  - GROUP_ID is hard-coded to c7e35e47-cb80-4816-abaf-2c96b57fe0d2 only —
 *    no other group can ever be touched by this script.
 *  - Candidate selection (STEP 0, read-only) only accepts a
 *    telegram_message in that group that has a passport_ocr_results row
 *    AND has no sheet_sync_queue row yet — this automatically excludes the
 *    3 pre-existing 'failed' jobs from earlier debugging (they already
 *    have a queue row), so this script can never touch them.
 *  - DRY RUN BY DEFAULT: everything past STEP 0 only happens if
 *    CONFIRM_E2E_WRITE=yes is set. The dry-run output prints only the
 *    group id, the candidate's telegram_message_id, and its
 *    passport_ocr_results row's own internal id — never any passport
 *    field (name, passport number, dates, gender, etc.).
 *  - Confirmed mode creates exactly ONE sheet_sync_queue job (via the
 *    real enqueueSheetSync) and syncs exactly that one message (via the
 *    real syncPassportRowToSheet) — never touches any other row.
 *  - Idempotency check re-syncs the SAME job and compares the technical-id
 *    (column M) row COUNT before/after, and the recorded sheet row number
 *    before/after — never prints the actual passport data written to any
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
const CONFIRM = process.env.CONFIRM_E2E_WRITE === 'yes';

interface Candidate {
  telegramMessageId: string;
  ocrResultId: string;
}

async function findCandidate(): Promise<Candidate | null> {
  const { rows } = await pool.query<{ telegram_message_id: string; ocr_result_id: string }>(
    `SELECT tm.id AS telegram_message_id, por.id AS ocr_result_id
     FROM telegram_messages tm
     JOIN passport_ocr_results por ON por.telegram_message_id = tm.id
     LEFT JOIN sheet_sync_queue ssq ON ssq.telegram_message_id = tm.id
     WHERE tm.group_id = $1
       AND ssq.id IS NULL
     ORDER BY tm.created_at DESC
     LIMIT 1`,
    [GROUP_ID],
  );
  const row = rows[0];
  if (!row) return null;
  return { telegramMessageId: row.telegram_message_id, ocrResultId: row.ocr_result_id };
}

async function main(): Promise<void> {
  console.log('[single-row-sync] === STEP 0: candidate selection within the one allowed group (read-only) ===');
  console.log('[single-row-sync] group_id:', GROUP_ID);

  const candidate = await findCandidate();
  if (!candidate) {
    console.log(
      '[single-row-sync] no eligible message found (needs a passport_ocr_results row and no existing ' +
        'sheet_sync_queue row) -- nothing to test.',
    );
    return;
  }
  console.log('[single-row-sync] candidate telegram_message_id:', candidate.telegramMessageId);
  console.log('[single-row-sync] candidate ocr_result internal id (not passport data):', candidate.ocrResultId);

  if (!CONFIRM) {
    console.log('[single-row-sync] DRY RUN (CONFIRM_E2E_WRITE is not "yes") -- stopping here. Nothing was written.');
    console.log('[single-row-sync] re-run with CONFIRM_E2E_WRITE=yes to enqueue + sync this one message.');
    return;
  }

  console.log('[single-row-sync] === STEP 1: enqueueSheetSync (real production function, one INSERT) ===');
  const job = await enqueueSheetSync(candidate.telegramMessageId);
  if (!job) {
    console.log('[single-row-sync] enqueueSheetSync returned null (a job already existed) -- stopping, not touching it.');
    return;
  }
  console.log('[single-row-sync] job created:', { id: job.id, status: job.status, attempts: job.attempts });

  console.log('[single-row-sync] === STEP 2: syncPassportRowToSheet (the SAME function the real worker calls) ===');
  await syncPassportRowToSheet(job.id);

  const afterFirstSync = await findSheetSyncQueueById(job.id);
  if (!afterFirstSync || afterFirstSync.status !== 'synced') {
    console.log('[single-row-sync] SYNC DID NOT SUCCEED -- stopping before the idempotency check:', afterFirstSync);
    return;
  }
  console.log('[single-row-sync] job synced:', {
    status: afterFirstSync.status,
    attempts: afterFirstSync.attempts,
    sheetRowNumber: afterFirstSync.sheetRowNumber,
  });

  const group = await findGroupById(GROUP_ID);
  const spreadsheetId = group?.googleSheetId ?? null;
  if (!spreadsheetId) {
    console.log('[single-row-sync] FAILED -- group has no google_sheet_id (unexpected; it should already have one).');
    return;
  }
  console.log('[single-row-sync] spreadsheetId:', spreadsheetId);
  console.log('[single-row-sync] spreadsheet URL (for manual review):', `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`);

  console.log('[single-row-sync] === STEP 3: idempotency -- re-sync the SAME job, expect no duplicate row ===');
  const writeClient = buildRealSheetsWriteClient();
  const idColumnBefore = await writeClient.getTechnicalIdColumn(spreadsheetId);
  console.log('[single-row-sync] technical-id (column M) row count before re-sync:', idColumnBefore.length);

  await pool.query(`UPDATE sheet_sync_queue SET status = 'pending', next_attempt_at = now() WHERE id = $1`, [job.id]);
  await syncPassportRowToSheet(job.id);

  const afterSecondSync = await findSheetSyncQueueById(job.id);
  console.log('[single-row-sync] job after second sync:', {
    status: afterSecondSync?.status,
    attempts: afterSecondSync?.attempts,
    sheetRowNumber: afterSecondSync?.sheetRowNumber,
  });

  const idColumnAfter = await writeClient.getTechnicalIdColumn(spreadsheetId);
  console.log('[single-row-sync] technical-id (column M) row count after re-sync:', idColumnAfter.length);
  console.log('[single-row-sync] STEP 3 result: no duplicate row appended =', idColumnAfter.length === idColumnBefore.length);
  console.log(
    '[single-row-sync] STEP 3 result: sheet row number unchanged across both syncs =',
    afterFirstSync.sheetRowNumber === afterSecondSync?.sheetRowNumber,
  );

  console.log('[single-row-sync] DONE. Worker was never started; this process ran once and will exit.');
}

main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : 'unknown error';
    console.error('[single-row-sync] FAILED:', message.slice(0, 300));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
