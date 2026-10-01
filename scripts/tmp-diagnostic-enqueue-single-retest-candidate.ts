/**
 * TEMPORARY ONE-OFF ACTION SCRIPT — not part of the production OCR/Sheets
 * pipeline. Never imported by src/, never wired into any worker.
 *
 * Purpose: safely test the deterministic upsertRowInSheet.ts fix against
 * exactly ONE real, already-existing, fully-linked passport job, by calling
 * the pipeline's own existing, already-idempotent enqueueSheetSync()
 * (src/db/repositories/sheetSyncQueue.repo.ts — re-read and confirmed
 * immediately before writing this script: `enqueueSheetSync(telegramMessageId:
 * string): Promise<SheetSyncQueueRecord | null>`, backed by `INSERT INTO
 * sheet_sync_queue (telegram_message_id) VALUES ($1) ON CONFLICT
 * (telegram_message_id) DO NOTHING RETURNING ...`).
 *
 * This performs exactly ONE INSERT, for exactly ONE hardcoded
 * telegram_message_id (TARGET_TELEGRAM_MESSAGE_ID below), identified by the
 * earlier read-only tmp-diagnostic-find-safe-retest-candidate.ts run as the
 * most recent fully-linked, OCR-complete passport with NO existing
 * sheet_sync_queue row at all.
 *
 * Why this is safe:
 *  - sheet_sync_queue.telegram_message_id is UNIQUE with ON CONFLICT DO
 *    NOTHING — this INSERT can only ever create a brand-new row for THIS ID,
 *    or no-op if one somehow already exists. It is structurally impossible
 *    for this statement to modify any OTHER row's status, synced_at,
 *    sheet_row_number, or any other field. The 15 pre-existing 'synced' rows
 *    are a WHERE-clause away from anything this script touches.
 *  - A pre-check (below) re-confirms immediately before the insert that (a)
 *    the target message exists, is fully linked (group+agent), has a
 *    completed OCR result, and (b) it currently has NO sheet_sync_queue row
 *    — if either check fails, the script aborts WITHOUT calling
 *    enqueueSheetSync at all.
 *  - No Sheets API call is made here. No passport/OCR/Telegram data is read,
 *    written, or logged (only ids/timestamps/status/counts). No service is
 *    started, stopped, or restarted. No Tesseract/local OCR is invoked. The
 *    already-running ocrumra-sheets-sync.service (already on the fixed
 *    deterministic code, confirmed by tmp-diagnostic-post-fix-verification.ts)
 *    will pick this new 'pending' row up entirely on its own next poll —
 *    this script never calls syncPassportRowToSheet or any Sheets write
 *    itself.
 *  - Before/after sheet_sync_queue counts (by status) are printed so the
 *    other 15 rows' untouched-ness is directly visible in this same output,
 *    not merely asserted.
 *
 * PRIVACY: only ids, booleans, counts, timestamps, and enum status values
 * are ever printed. No passport/OCR/Telegram field content is logged.
 */
import { pool } from '../src/db/pool.js';
import { enqueueSheetSync } from '../src/db/repositories/sheetSyncQueue.repo.js';

const TARGET_TELEGRAM_MESSAGE_ID = '52e2bbfe-7a24-4b44-bde9-95ddb904a200';

interface PreCheckRow {
  telegram_message_id: string;
  group_id: string | null;
  agent_id: string | null;
  ocr_result_id: string | null;
  existing_queue_id: string | null;
  existing_queue_status: string | null;
}

interface StatusCountRow {
  status: string;
  count: string;
}

async function printStatusCounts(label: string): Promise<void> {
  const { rows } = await pool.query<StatusCountRow>(
    `SELECT status, COUNT(*)::text AS count FROM sheet_sync_queue GROUP BY status ORDER BY status`,
  );
  console.log(`[enqueue-single-candidate] ${label} sheet_sync_queue status counts:`);
  for (const r of rows) {
    console.log(`[enqueue-single-candidate]   ${r.status}: ${r.count}`);
  }
}

async function main(): Promise<void> {
  console.log('[enqueue-single-candidate] === target ===');
  console.log(`[enqueue-single-candidate] TARGET_TELEGRAM_MESSAGE_ID=${TARGET_TELEGRAM_MESSAGE_ID}`);

  console.log('[enqueue-single-candidate] === pre-check: is this message still a safe, fully-linked, queue-less candidate? ===');
  const { rows: preCheckRows } = await pool.query<PreCheckRow>(
    `SELECT
       tm.id AS telegram_message_id,
       tm.group_id,
       tm.agent_id,
       por.id AS ocr_result_id,
       ssq.id AS existing_queue_id,
       ssq.status AS existing_queue_status
     FROM telegram_messages tm
     LEFT JOIN passport_ocr_results por ON por.telegram_message_id = tm.id
     LEFT JOIN sheet_sync_queue ssq ON ssq.telegram_message_id = tm.id
     WHERE tm.id = $1`,
    [TARGET_TELEGRAM_MESSAGE_ID],
  );

  const preCheck = preCheckRows[0];
  if (!preCheck) {
    console.error('[enqueue-single-candidate] ABORT: telegram_message_id not found at all. Nothing inserted.');
    process.exitCode = 1;
    return;
  }

  console.log(
    `[enqueue-single-candidate]   group_id_present=${preCheck.group_id !== null}  agent_id_present=${preCheck.agent_id !== null}  ` +
      `ocr_result_present=${preCheck.ocr_result_id !== null}  existing_queue_id=${preCheck.existing_queue_id ?? '(none)'}  ` +
      `existing_queue_status=${preCheck.existing_queue_status ?? '(none)'}`,
  );

  if (preCheck.group_id === null || preCheck.agent_id === null || preCheck.ocr_result_id === null) {
    console.error('[enqueue-single-candidate] ABORT: message is not fully-linked / OCR-complete. Nothing inserted.');
    process.exitCode = 1;
    return;
  }

  if (preCheck.existing_queue_id !== null) {
    console.error(
      '[enqueue-single-candidate] ABORT: a sheet_sync_queue row already exists for this message ' +
        `(id=${preCheck.existing_queue_id}, status=${preCheck.existing_queue_status}). This script only targets a ` +
        'message with NO existing queue row, to keep the test unambiguous. Nothing inserted.',
    );
    process.exitCode = 1;
    return;
  }

  await printStatusCounts('BEFORE insert —');

  console.log('[enqueue-single-candidate] === calling enqueueSheetSync() exactly once for the target id ===');
  const result = await enqueueSheetSync(TARGET_TELEGRAM_MESSAGE_ID);

  if (result === null) {
    console.log(
      '[enqueue-single-candidate]   enqueueSheetSync returned null — a row already existed at the moment of the ' +
        'insert (ON CONFLICT DO NOTHING no-op). No new row was created.',
    );
  } else {
    console.log(
      `[enqueue-single-candidate]   NEW ROW CREATED: id=${result.id}  status=${result.status}  ` +
        `sheet_row_number=${result.sheetRowNumber ?? '(none yet)'}  synced_at=${result.syncedAt ?? '(none yet)'}  ` +
        `created_at=${result.createdAt}`,
    );
  }

  await printStatusCounts('AFTER insert —');

  console.log(
    '[enqueue-single-candidate] DONE. Exactly one INSERT attempted, for exactly one telegram_message_id, via the ' +
      "pipeline's own idempotent enqueueSheetSync(). No other row can have been affected (UNIQUE + ON CONFLICT DO " +
      'NOTHING + WHERE-less bare INSERT touches only the new row). No Sheets API call was made. No service was ' +
      'started/stopped/restarted. The already-running ocrumra-sheets-sync.service will pick this job up on its own ' +
      'next normal poll cycle — nothing further needs to happen here for that to occur.',
  );
}

main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : 'unknown error';
    console.error('[enqueue-single-candidate] FAILED:', message.slice(0, 500));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
