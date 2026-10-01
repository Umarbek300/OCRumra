/**
 * TEMPORARY ONE-OFF DIAGNOSTIC — not part of the production OCR/Sheets
 * pipeline. Never imported by src/, never wired into any worker.
 *
 * READ-ONLY audit of sheet_sync_queue for the one test group, run before any
 * decision to enable SHEETS_SYNC_ENABLED / start the worker, to establish
 * exactly what is currently sitting in the queue: the successful E2E job
 * (fba10826-...), the 3 known stale 'failed' jobs from earlier debugging
 * (6431e8ac-..., 8c77e99f-..., 37c616ad-...), and anything else.
 *
 * A single SELECT against sheet_sync_queue joined to telegram_messages on
 * group_id -- no other table, no aggregation that could leak content.
 *
 * Never INSERTs/UPDATEs/DELETEs anything, never touches Google
 * Sheets/Drive/Apps Script, never starts the worker, never invokes any OCR
 * provider (Tesseract or Google Vision) -- this only reads pre-existing
 * sheet_sync_queue rows.
 *
 * PRIVACY: only ids, enum status, attempts count, sheet_row_number, and
 * whether last_error is present (never its text, in case it ever echoed
 * request/response content) are read/printed -- never any passport field.
 */
import { pool } from '../src/db/pool.js';

const GROUP_ID = 'c7e35e47-cb80-4816-abaf-2c96b57fe0d2';

const KNOWN_STALE_FAILED_JOB_IDS = [
  '6431e8ac-ac32-4c00-8628-abd5fe0a6614',
  '8c77e99f-e0ca-4871-be0d-73b30c84a1f4',
  '37c616ad-7548-4748-b174-35f763b8e084',
];
const SUCCESSFUL_E2E_JOB_ID = 'fba10826-7357-43e1-982e-4d320d3a9208';

interface QueueRow {
  job_id: string;
  telegram_message_id: string;
  status: string;
  attempts: number;
  sheet_row_number: number | null;
  has_last_error: boolean;
}

async function main(): Promise<void> {
  console.log('[queue-pre-worker-audit] group_id:', GROUP_ID);

  const { rows } = await pool.query<QueueRow>(
    `SELECT
       ssq.id AS job_id,
       ssq.telegram_message_id,
       ssq.status,
       ssq.attempts,
       ssq.sheet_row_number,
       (ssq.last_error IS NOT NULL) AS has_last_error
     FROM sheet_sync_queue ssq
     JOIN telegram_messages tm ON tm.id = ssq.telegram_message_id
     WHERE tm.group_id = $1
     ORDER BY ssq.created_at`,
    [GROUP_ID],
  );

  console.log('[queue-pre-worker-audit] === 1) all sheet_sync_queue rows for this group ===');
  console.log('[queue-pre-worker-audit] total rows:', rows.length);
  for (const row of rows) {
    console.log(
      `[queue-pre-worker-audit]   job_id=${row.job_id}  telegram_message_id=${row.telegram_message_id}  ` +
        `status=${row.status}  attempts=${row.attempts}  sheet_row_number=${row.sheet_row_number ?? '(null)'}  ` +
        `has_last_error=${row.has_last_error}`,
    );
  }

  console.log('[queue-pre-worker-audit] === 2) known stale failed jobs from earlier debugging ===');
  for (const jobId of KNOWN_STALE_FAILED_JOB_IDS) {
    const row = rows.find((r) => r.job_id === jobId);
    if (!row) {
      console.log(`[queue-pre-worker-audit]   job_id=${jobId}: NOT FOUND (may have been in a different group, or already removed)`);
      continue;
    }
    console.log(
      `[queue-pre-worker-audit]   job_id=${row.job_id}  status=${row.status}  attempts=${row.attempts}  ` +
        `sheet_row_number=${row.sheet_row_number ?? '(null)'}  has_last_error=${row.has_last_error}`,
    );
  }

  console.log('[queue-pre-worker-audit] === 3) successful E2E job ===');
  const e2eRow = rows.find((r) => r.job_id === SUCCESSFUL_E2E_JOB_ID);
  if (!e2eRow) {
    console.log(`[queue-pre-worker-audit]   job_id=${SUCCESSFUL_E2E_JOB_ID}: NOT FOUND (unexpected)`);
  } else {
    console.log(
      `[queue-pre-worker-audit]   job_id=${e2eRow.job_id}  status=${e2eRow.status}  attempts=${e2eRow.attempts}  ` +
        `sheet_row_number=${e2eRow.sheet_row_number ?? '(null)'}  has_last_error=${e2eRow.has_last_error}`,
    );
  }

  console.log('[queue-pre-worker-audit] === 4) status breakdown (counts only) ===');
  const statusCounts = new Map<string, number>();
  for (const row of rows) {
    statusCounts.set(row.status, (statusCounts.get(row.status) ?? 0) + 1);
  }
  for (const [status, count] of statusCounts) {
    console.log(`[queue-pre-worker-audit]   status=${status}: count=${count}`);
  }

  console.log('[queue-pre-worker-audit] DONE -- read-only, nothing was created, modified, or deleted.');
}

main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : 'unknown error';
    console.error('[queue-pre-worker-audit] FAILED:', message.slice(0, 300));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
