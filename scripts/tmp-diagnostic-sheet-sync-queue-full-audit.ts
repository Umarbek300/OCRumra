/**
 * TEMPORARY ONE-OFF DIAGNOSTIC — not part of the production OCR/Sheets
 * pipeline. Never imported by src/, never wired into any worker.
 *
 * READ-ONLY full audit of every row currently in sheet_sync_queue (not
 * scoped to one group this time) -- run after the SHEETS_SYNC_ENABLED
 * parsing fix was deployed, to establish exactly what would happen if the
 * sheet-sync worker were ever started: how many jobs exist, their
 * status/attempts/next_attempt_at/sheet_row_number, which are 'failed',
 * and which are currently eligible for retry under findDueSheetSyncJobs's
 * own WHERE clause (status IN ('pending','failed') AND next_attempt_at <=
 * now() AND attempts < MAX_SHEET_SYNC_ATTEMPTS).
 *
 * A single SELECT against sheet_sync_queue -- no other table, no writes.
 *
 * Never INSERTs/UPDATEs/DELETEs anything, never touches Google
 * Sheets/Drive/Apps Script, never starts/restarts any worker or service,
 * never invokes any OCR provider (Tesseract or Google Vision).
 *
 * PRIVACY: only ids, enum status, attempts count, timestamps, and
 * sheet_row_number are read/printed. last_error is only reported as a
 * length + a fixed set of safe keyword-category booleans (same pattern as
 * tmp-diagnostic-sheets-stale-failed-jobs-error-classification.ts earlier
 * in this session) -- its raw text is never printed, since it could in
 * principle echo request/response details from a pre-Apps-Script debugging
 * era.
 */
import { pool } from '../src/db/pool.js';

const MAX_SHEET_SYNC_ATTEMPTS = 5; // must match src/db/repositories/sheetSyncQueue.repo.ts's own exported constant

interface QueueRow {
  id: string;
  telegram_message_id: string;
  status: string;
  attempts: number;
  next_attempt_at: string;
  sheet_row_number: number | null;
  last_error: string | null;
  is_due_now: boolean;
}

interface Category {
  key: string;
  pattern: RegExp;
}

const CATEGORIES: Category[] = [
  { key: 'permission', pattern: /permission|forbidden|unauthorized|access denied|401|403/i },
  { key: 'not_found', pattern: /not found|404|no such file|does not exist/i },
  { key: 'timeout_network', pattern: /timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|network/i },
  { key: 'apps_script', pattern: /apps script|doPost|web app|shared secret|requestId/i },
  { key: 'config', pattern: /not configured|drive_folder_id|folder/i },
  { key: 'quota', pattern: /quota|rate limit|429|storage quota/i },
  { key: 'validation', pattern: /invalid|malformed|zod|schema|parse/i },
];

function classifyError(lastError: string | null): string {
  if (!lastError) return '(none)';
  const matched = CATEGORIES.filter((c) => c.pattern.test(lastError)).map((c) => c.key);
  return matched.length > 0 ? `${matched.join('+')} (len=${lastError.length})` : `unclassified (len=${lastError.length})`;
}

async function main(): Promise<void> {
  const { rows } = await pool.query<QueueRow>(
    `SELECT
       id, telegram_message_id, status, attempts, next_attempt_at, sheet_row_number, last_error,
       (status IN ('pending', 'failed') AND next_attempt_at <= now() AND attempts < $1) AS is_due_now
     FROM sheet_sync_queue
     ORDER BY created_at`,
    [MAX_SHEET_SYNC_ATTEMPTS],
  );

  console.log('[full-queue-audit] === all sheet_sync_queue rows ===');
  console.log('[full-queue-audit] total rows:', rows.length);
  for (const row of rows) {
    console.log(
      `[full-queue-audit]   id=${row.id}  telegram_message_id=${row.telegram_message_id}  status=${row.status}  ` +
        `attempts=${row.attempts}/${MAX_SHEET_SYNC_ATTEMPTS}  next_attempt_at=${row.next_attempt_at}  ` +
        `sheet_row_number=${row.sheet_row_number ?? '(null)'}  last_error=${classifyError(row.last_error)}  ` +
        `due_now=${row.is_due_now}`,
    );
  }

  const failedRows = rows.filter((r) => r.status === 'failed');
  console.log('[full-queue-audit] === failed jobs detail ===');
  for (const row of failedRows) {
    console.log(
      `[full-queue-audit]   FAILED id=${row.id}  attempts=${row.attempts}/${MAX_SHEET_SYNC_ATTEMPTS}  ` +
        `next_attempt_at=${row.next_attempt_at}  due_now=${row.is_due_now}  last_error=${classifyError(row.last_error)}`,
    );
  }

  const statusCounts = new Map<string, number>();
  for (const row of rows) statusCounts.set(row.status, (statusCounts.get(row.status) ?? 0) + 1);
  const dueCount = rows.filter((r) => r.is_due_now).length;

  console.log('[full-queue-audit] === SUMMARY ===');
  console.log('[full-queue-audit] total jobs:', rows.length);
  for (const [status, count] of statusCounts) {
    console.log(`[full-queue-audit]   status=${status}: ${count}`);
  }
  console.log('[full-queue-audit]   eligible for retry right now (due_now=true):', dueCount);

  console.log('[full-queue-audit] === code-based expected outcome if these failed jobs were retried ===');
  console.log(
    '[full-queue-audit]   src/sheets/syncPassportRowToSheet.ts:91 -- each retry calls ensureGroupSheet(groupId), ' +
      "which for a group with an existing google_sheet_id takes the fast path (no Apps Script call at all, per " +
      'ensureGroupSheet.ts) -- Apps Script provisioning would only be invoked for a group that has NEVER had a ' +
      'spreadsheet created yet.',
  );
  console.log(
    '[full-queue-audit]   src/sheets/upsertRowInSheet.ts:128-146 -- the actual row write then goes through the ' +
      'same column-M lookup as always (append if the message has no existing row, update in place if it does) -- ' +
      'no duplicate-row risk regardless of how many times a job is retried.',
  );
  console.log(
    '[full-queue-audit]   Given the earlier error classification of the historical failed jobs in this session ' +
      "(all 'permission' category, from before Apps Script provisioning existed) and the fact that provisioning " +
      'has since been replaced and independently verified twice (2 successful synced jobs), a retry of a job whose ' +
      "group already has a google_sheet_id is expected to succeed on the Sheets/Drive side -- but a retry's actual " +
      'outcome still depends on that job\'s own passport_ocr_results completeness, which this script does not ' +
      're-check (see earlier per-job OCR completeness audits in this session for that).',
  );

  console.log('[full-queue-audit] DONE -- read-only, nothing was created, modified, or deleted.');
}

main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : 'unknown error';
    console.error('[full-queue-audit] FAILED:', message.slice(0, 300));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
