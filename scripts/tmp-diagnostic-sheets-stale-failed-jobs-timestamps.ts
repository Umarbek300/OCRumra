/**
 * TEMPORARY ONE-OFF DIAGNOSTIC — not part of the production OCR/Sheets
 * pipeline. Never imported by src/, never wired into any worker.
 *
 * READ-ONLY: a single SELECT of next_attempt_at / created_at / updated_at
 * for the 3 known stale 'failed' sheet_sync_queue jobs from earlier
 * debugging, to determine whether/when the worker (once started) would
 * treat each as due for retry -- eligibility is next_attempt_at <= now()
 * AND attempts < MAX_SHEET_SYNC_ATTEMPTS (see findDueSheetSyncJobs in
 * src/db/repositories/sheetSyncQueue.repo.ts), so this also reports each
 * comparison directly rather than leaving it to be worked out by hand.
 *
 * Never INSERTs/UPDATEs/DELETEs anything, never touches Google
 * Sheets/Drive/Apps Script, never starts the worker, never invokes any OCR
 * provider (Tesseract or Google Vision).
 *
 * PRIVACY: only ids, timestamps, attempts count, and status are
 * read/printed -- no passport field, no last_error text.
 */
import { pool } from '../src/db/pool.js';

const JOB_IDS = [
  '37c616ad-7548-4748-b174-35f763b8e084',
  '6431e8ac-ac32-4c00-8628-abd5fe0a6614',
  '8c77e99f-e0ca-4871-be0d-73b30c84a1f4',
];
const MAX_SHEET_SYNC_ATTEMPTS = 5; // must match src/db/repositories/sheetSyncQueue.repo.ts's own exported constant

interface JobRow {
  id: string;
  status: string;
  attempts: number;
  next_attempt_at: string;
  created_at: string;
  updated_at: string;
  is_due_now: boolean;
}

async function main(): Promise<void> {
  const { rows } = await pool.query<JobRow>(
    `SELECT
       id, status, attempts, next_attempt_at, created_at, updated_at,
       (next_attempt_at <= now() AND attempts < $2) AS is_due_now
     FROM sheet_sync_queue
     WHERE id = ANY($1::uuid[])`,
    [JOB_IDS, MAX_SHEET_SYNC_ATTEMPTS],
  );

  console.log('[stale-failed-timestamps] === per-job timestamps (read-only) ===');
  for (const jobId of JOB_IDS) {
    const row = rows.find((r) => r.id === jobId);
    if (!row) {
      console.log(`[stale-failed-timestamps] job_id=${jobId}: NOT FOUND (unexpected)`);
      continue;
    }
    console.log(`[stale-failed-timestamps] job_id=${row.id}`);
    console.log(`[stale-failed-timestamps]   status=${row.status}  attempts=${row.attempts}/${MAX_SHEET_SYNC_ATTEMPTS}`);
    console.log(`[stale-failed-timestamps]   created_at=${row.created_at}`);
    console.log(`[stale-failed-timestamps]   updated_at=${row.updated_at}`);
    console.log(`[stale-failed-timestamps]   next_attempt_at=${row.next_attempt_at}`);
    console.log(
      `[stale-failed-timestamps]   eligible now under findDueSheetSyncJobs's WHERE clause ` +
        `(next_attempt_at <= now() AND attempts < ${MAX_SHEET_SYNC_ATTEMPTS}): ${row.is_due_now}`,
    );
  }

  console.log('[stale-failed-timestamps] === relevant code (read-only reference, not executed) ===');
  console.log(
    '[stale-failed-timestamps]   src/db/repositories/sheetSyncQueue.repo.ts:118-130 findDueSheetSyncJobs -- ' +
      "WHERE status IN ('pending', 'failed') AND next_attempt_at <= now() AND attempts < $2 ORDER BY next_attempt_at LIMIT $1",
  );
  console.log(
    '[stale-failed-timestamps]   src/db/repositories/sheetSyncQueue.repo.ts:138-148 markSheetSyncStarted -- ' +
      "atomically claims: UPDATE ... SET status='syncing', attempts=attempts+1 WHERE id=$1 AND status IN ('pending','failed')",
  );
  console.log(
    '[stale-failed-timestamps]   src/db/repositories/sheetSyncQueue.repo.ts:101 MAX_SHEET_SYNC_ATTEMPTS = 5 -- ' +
      'a failed row with attempts >= 5 is permanently excluded from findDueSheetSyncJobs (stays visible, never auto-retried again)',
  );
  console.log(
    '[stale-failed-timestamps]   src/sheets/syncPassportRowToSheet.ts:22-29 BACKOFF_SCHEDULE_MINUTES=[1,5,30,60] / ' +
      'computeSheetSyncBackoff -- on failure, next_attempt_at is set to now()+schedule[min(attempts,4)-1] minutes ' +
      '(attempts=1 -> +1 min, the schedule these 3 stale jobs would have used when they failed)',
  );
  console.log(
    '[stale-failed-timestamps]   src/sheets/runSheetSyncLoop.ts:63-78 runSheetSyncLoop -- polls findDueSheetSyncJobs ' +
      'then calls syncPassportRowToSheet(job.id) per due job; runs continuously once started regardless of ' +
      'SHEETS_SYNC_ENABLED (that flag is read elsewhere, per this file\'s own doc comment) -- confirms retry timing ' +
      'is governed purely by next_attempt_at/attempts, not by a separate stale-job allowlist.',
  );

  console.log('[stale-failed-timestamps] DONE -- read-only, nothing was created, modified, or deleted.');
}

main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : 'unknown error';
    console.error('[stale-failed-timestamps] FAILED:', message.slice(0, 300));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
