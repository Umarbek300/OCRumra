/**
 * TEMPORARY ONE-OFF DIAGNOSTIC — not part of the production OCR/Sheets
 * pipeline. Never imported by src/, never wired into any worker.
 *
 * FINAL READ-ONLY PREFLIGHT before ever retrying the 3 known stale 'failed'
 * sheet_sync_queue jobs (37c616ad-..., 6431e8ac-..., 8c77e99f-...). Combines
 * everything checked piecemeal earlier in this session into one PASS/FAIL
 * report, plus two READ-ONLY analyses (duplicate-row risk, № sequence
 * preservation) grounded in the actual upsertRowInSheet.ts/runSheetSyncLoop.ts
 * source and the sheet's current live state.
 *
 * This script does NOT retry anything itself -- it only reads:
 *   1) env.SHEETS_SYNC_ENABLED (must still be false)
 *   2) `ps aux` (read-only, via child_process.execSync) for any process
 *      matching the sheets-sync worker's known entrypoints/npm script name
 *   3) groups.google_sheet_id for the test group
 *   4) the sheet's own A2:M data (row count, № sequence, technical-id
 *      uniqueness) -- same checks as the earlier row-sequence audit, re-run
 *      fresh here
 *   5) current status/attempts/sheet_row_number for the 3 target jobs
 *   6) whether any of the 3 target telegram_message_ids already appear in
 *      the sheet's technical-id column (the actual live signal
 *      upsertRowInSheet.ts's own column-M lookup would see)
 *   7) the relevant code paths (quoted, not executed) that determine
 *      duplicate-avoidance and № sequencing behavior
 *
 * Never INSERTs/UPDATEs/DELETEs anything in the DB, never writes to Google
 * Sheets/Drive/Apps Script, never starts/restarts the worker, never invokes
 * any OCR provider (Tesseract or Google Vision).
 *
 * PRIVACY: only ids, booleans, counts, enum/status values, and short code
 * excerpts (no passport field, no last_error text, no agent name) are
 * printed.
 */
import { execSync } from 'node:child_process';
import { env } from '../src/config/env.js';
import { pool } from '../src/db/pool.js';
import { getSheetsClients } from '../src/sheets/sheetsAuth.js';
import { FIRST_DATA_ROW_NUMBER, TECHNICAL_ID_COLUMN_LETTER } from '../src/sheets/sheetLayout.js';

const GROUP_ID = 'c7e35e47-cb80-4816-abaf-2c96b57fe0d2';
const TARGET_JOB_IDS = [
  '37c616ad-7548-4748-b174-35f763b8e084',
  '6431e8ac-ac32-4c00-8628-abd5fe0a6614',
  '8c77e99f-e0ca-4871-be0d-73b30c84a1f4',
];
const WORKER_PROCESS_PATTERNS = ['runSheetSyncLoop', 'sheets/start', 'sheets:worker'];

interface CheckResult {
  label: string;
  pass: boolean;
  detail: string;
}

const results: CheckResult[] = [];

function record(label: string, pass: boolean, detail: string): void {
  results.push({ label, pass, detail });
  console.log(`[retry-preflight] [${pass ? 'PASS' : 'FAIL'}] ${label} -- ${detail}`);
}

async function main(): Promise<void> {
  console.log('[retry-preflight] === 1) SHEETS_SYNC_ENABLED ===');
  record('SHEETS_SYNC_ENABLED is false', env.SHEETS_SYNC_ENABLED === false, `current value: ${env.SHEETS_SYNC_ENABLED}`);

  console.log('[retry-preflight] === 2) worker process not running (read-only `ps aux` check) ===');
  let psOutput = '';
  try {
    psOutput = execSync('ps aux', { encoding: 'utf8' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    console.log(`[retry-preflight]   could not run 'ps aux': ${message.slice(0, 200)}`);
  }
  const matchingLines = psOutput
    .split('\n')
    .filter((line) => WORKER_PROCESS_PATTERNS.some((pattern) => line.includes(pattern)))
    .filter((line) => !line.includes('grep') && !line.includes('tmp-diagnostic-sheets-retry-final-preflight'));
  record(
    'no sheets-sync worker process found',
    matchingLines.length === 0,
    `${matchingLines.length} matching process line(s) found (patterns: ${WORKER_PROCESS_PATTERNS.join(', ')})`,
  );

  console.log('[retry-preflight] === 3) group.google_sheet_id ===');
  const { rows: groupRows } = await pool.query<{ google_sheet_id: string | null }>(
    `SELECT google_sheet_id FROM groups WHERE id = $1`,
    [GROUP_ID],
  );
  const spreadsheetId = groupRows[0]?.google_sheet_id ?? null;
  record('group has a google_sheet_id', spreadsheetId !== null, spreadsheetId ? `spreadsheetId=${spreadsheetId}` : 'no group or null google_sheet_id');
  if (!spreadsheetId) {
    console.log('[retry-preflight] cannot continue sheet-side checks without a spreadsheetId -- stopping here.');
    printSummary();
    return;
  }

  console.log('[retry-preflight] === 4) sheet data rows: count, № sequence, technical-id uniqueness ===');
  const { sheets } = getSheetsClients();
  const range = `A${FIRST_DATA_ROW_NUMBER}:${TECHNICAL_ID_COLUMN_LETTER}`;
  const response = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const rawRows = response.data.values ?? [];
  const numberValues = rawRows.map((raw) => (typeof raw[0] === 'string' && raw[0].length > 0 ? Number(raw[0]) : null));
  const technicalIds = rawRows.map((raw) => (typeof raw[12] === 'string' && raw[12].length > 0 ? raw[12] : null)).filter((id): id is string => id !== null);
  const sequenceOk = numberValues.every((value, index) => value === index + 1);
  const uniqueOk = new Set(technicalIds).size === technicalIds.length;
  console.log(`[retry-preflight]   total data rows: ${rawRows.length}`);
  record('№ sequence intact (1..N, no gaps/repeats)', sequenceOk, `values seen: [${numberValues.join(', ')}]`);
  record('technical ids (column M) all unique', uniqueOk, `${technicalIds.length} non-empty ids, ${new Set(technicalIds).size} unique`);

  console.log('[retry-preflight] === 5) current status of the 3 target jobs ===');
  const { rows: jobRows } = await pool.query<{
    id: string;
    telegram_message_id: string;
    status: string;
    attempts: number;
    sheet_row_number: number | null;
  }>(
    `SELECT id, telegram_message_id, status, attempts, sheet_row_number FROM sheet_sync_queue WHERE id = ANY($1::uuid[])`,
    [TARGET_JOB_IDS],
  );
  for (const jobId of TARGET_JOB_IDS) {
    const job = jobRows.find((r) => r.id === jobId);
    if (!job) {
      console.log(`[retry-preflight]   job_id=${jobId}: NOT FOUND (unexpected)`);
      continue;
    }
    console.log(
      `[retry-preflight]   job_id=${job.id}  telegram_message_id=${job.telegram_message_id}  status=${job.status}  ` +
        `attempts=${job.attempts}  sheet_row_number=${job.sheet_row_number ?? '(null)'}`,
    );
  }
  const allStillFailed = TARGET_JOB_IDS.every((id) => jobRows.find((r) => r.id === id)?.status === 'failed');
  record('all 3 target jobs still in status=failed (unchanged since last audit)', allStillFailed, `statuses: ${jobRows.map((r) => `${r.id.slice(0, 8)}=${r.status}`).join(', ')}`);

  console.log('[retry-preflight] === 6) duplicate-row risk (live check + code reference) ===');
  const targetMessageIds = jobRows.map((r) => r.telegram_message_id);
  const alreadyInSheet = targetMessageIds.filter((id) => technicalIds.includes(id));
  record(
    'none of the 3 target telegram_message_ids already present in column M',
    alreadyInSheet.length === 0,
    alreadyInSheet.length === 0
      ? 'all 3 will take the APPEND path on retry (brand-new rows) -- no existing row for upsertRowInSheet to find or duplicate'
      : `${alreadyInSheet.length} already present -- those would take the UPDATE path instead (still no duplicate, but not a fresh append)`,
  );
  console.log(
    '[retry-preflight]   code reference: src/sheets/upsertRowInSheet.ts:128-146 upsertRowInSheet -- reads the full ' +
      'technical-id column via getTechnicalIdColumn, does idColumn.findIndex(id === telegramMessageId); found -> ' +
      'updateVisibleRow (UPDATE, column A never touched); not found -> appendFullRow (APPEND). Either branch can ' +
      'only ever produce exactly one row per telegram_message_id -- structurally cannot create a duplicate for a ' +
      'message that already has a row, and a never-synced message can only ever append once per successful call.',
  );

  console.log('[retry-preflight] === 7) № sequence preservation on retry (code reference) ===');
  console.log(
    '[retry-preflight]   code reference: src/sheets/upsertRowInSheet.ts:142 -- on APPEND, № is computed as ' +
      'idColumn.length + 1 (the CURRENT column-M row count at the moment of that call), not a fixed/precomputed value.',
  );
  console.log(
    '[retry-preflight]   code reference: src/sheets/runSheetSyncLoop.ts:126-134 -- due jobs are processed in a plain ' +
      "sequential `for` loop with `await deps.processJob(job.id)` per iteration; the NEXT job's upsertRowInSheet call " +
      'only runs after the previous one (including its append) has fully completed -- no concurrent appends from a ' +
      'single worker instance, so idColumn.length is always up to date for the next job in the same batch.',
  );
  console.log(
    `[retry-preflight]   current data row count is ${rawRows.length} -- if all 3 retries succeed one after another, ` +
      `expected № values are ${rawRows.length + 1}, ${rawRows.length + 2}, ${rawRows.length + 3} in whatever order ` +
      'findDueSheetSyncJobs happens to return them (ORDER BY next_attempt_at) -- sequence stays intact either way, ' +
      'just not necessarily in the 37c616ad/6431e8ac/8c77e99f order listed above.',
  );
  console.log(
    '[retry-preflight]   this guarantee assumes exactly one worker instance runs at a time -- markSheetSyncStarted\'s ' +
      "atomic claim (status IN ('pending','failed') -> 'syncing') already prevents two instances from double-" +
      'processing the same job, but running two instances concurrently could still interleave DIFFERENT jobs\' ' +
      'append calls and produce a non-contiguous (though still duplicate-free) № ordering -- out of scope for this ' +
      'preflight since only one worker is being considered.',
  );

  printSummary();
}

function printSummary(): void {
  console.log('[retry-preflight] === SUMMARY ===');
  const allPass = results.every((r) => r.pass);
  for (const r of results) {
    console.log(`[retry-preflight]   [${r.pass ? 'PASS' : 'FAIL'}] ${r.label}`);
  }
  console.log(`[retry-preflight] ALL CHECKS PASS: ${allPass}`);
  console.log(
    '[retry-preflight] Conditions for retry to be considered safe to START (not executed by this script): all ' +
      'above PASS, AND worker is only ever run as a single instance, AND SHEETS_SYNC_ENABLED is flipped to true only ' +
      'immediately before the intended retry window (not left on).',
  );
  console.log('[retry-preflight] DONE -- read-only, nothing was created, modified, or deleted. Worker was not started.');
}

main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : 'unknown error';
    console.error('[retry-preflight] FAILED:', message.slice(0, 300));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
