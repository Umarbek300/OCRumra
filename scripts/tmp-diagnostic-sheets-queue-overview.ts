/**
 * TEMPORARY ONE-OFF DIAGNOSTIC — not part of the production OCR/Sheets
 * pipeline. Never imported by src/, never wired into any worker.
 *
 * READ-ONLY: two SELECTs only. Never INSERTs/UPDATEs/DELETEs anything,
 * never enqueues a sheet_sync_queue job, never calls the OCR pipeline,
 * never touches Google Sheets/Drive/Apps Script at all.
 *
 * Purpose: explain the E2E dry-run's "no eligible candidate found" result
 * by showing, in aggregate, which groups have telegram_messages with a
 * passport_ocr_results row, whether each such group already has a
 * google_sheet_id, and what sheet_sync_queue status (if any) those
 * messages are in.
 *
 * PRIVACY: never selects or prints any passport/OCR field (name, surname,
 * passport number, dates, gender, MRZ, etc.) or any telegram sender info.
 * Only UUIDs (truncated to 8 chars for readability -- not a secret, just
 * shortened) and aggregate counts/booleans are printed.
 */
import { pool } from '../src/db/pool.js';

function shortId(id: string | null): string {
  if (!id) return '(none)';
  return id.slice(0, 8) + '…';
}

async function main(): Promise<void> {
  console.log('[queue-overview] === 1) groups with a passport_ocr_results-backed message, by google_sheet_id status ===');
  const { rows: groupRows } = await pool.query<{
    group_id: string | null;
    has_google_sheet_id: boolean;
    message_count: string;
  }>(
    `SELECT
       tm.group_id,
       (g.google_sheet_id IS NOT NULL) AS has_google_sheet_id,
       COUNT(*) AS message_count
     FROM telegram_messages tm
     JOIN passport_ocr_results por ON por.telegram_message_id = tm.id
     LEFT JOIN groups g ON g.id = tm.group_id
     GROUP BY tm.group_id, (g.google_sheet_id IS NOT NULL)
     ORDER BY tm.group_id NULLS FIRST`,
  );
  if (groupRows.length === 0) {
    console.log('[queue-overview] no telegram_messages have a passport_ocr_results row at all.');
  }
  for (const row of groupRows) {
    console.log(
      `[queue-overview]   group=${shortId(row.group_id)}  has_google_sheet_id=${row.has_google_sheet_id}  messages_with_ocr_result=${row.message_count}`,
    );
  }

  console.log('[queue-overview] === 2) sheet_sync_queue status for those same messages, by group ===');
  const { rows: queueRows } = await pool.query<{
    group_id: string | null;
    queue_status: string;
    message_count: string;
  }>(
    `SELECT
       tm.group_id,
       COALESCE(ssq.status::text, '(no queue row)') AS queue_status,
       COUNT(*) AS message_count
     FROM telegram_messages tm
     JOIN passport_ocr_results por ON por.telegram_message_id = tm.id
     LEFT JOIN sheet_sync_queue ssq ON ssq.telegram_message_id = tm.id
     GROUP BY tm.group_id, COALESCE(ssq.status::text, '(no queue row)')
     ORDER BY tm.group_id NULLS FIRST, queue_status`,
  );
  for (const row of queueRows) {
    console.log(`[queue-overview]   group=${shortId(row.group_id)}  queue_status=${row.queue_status}  message_count=${row.message_count}`);
  }

  console.log('[queue-overview] DONE -- read-only, nothing was inserted/updated/deleted, no OCR/Sheets/worker call was made.');
}

main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : 'unknown error';
    console.error('[queue-overview] FAILED:', message.slice(0, 300));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
