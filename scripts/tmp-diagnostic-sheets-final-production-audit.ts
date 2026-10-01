/**
 * TEMPORARY ONE-OFF DIAGNOSTIC — not part of the production OCR/Sheets
 * pipeline. Never imported by src/, never wired into any worker.
 *
 * FINAL READ-ONLY production audit of the Google Sheets sync feature, run
 * after all 3 known stale 'failed' sheet_sync_queue jobs were successfully
 * retried earlier in this session. Covers:
 *   1) every sheet_sync_queue row (id, telegram_message_id, status,
 *      attempts, sheet_row_number)
 *   2) status counts (pending/syncing/failed/synced)
 *   3) whether any pending/syncing/failed job remains
 *   4) any 'synced' job with a NULL sheet_row_number (would indicate a
 *      recording bug)
 *   5) sheet_row_number uniqueness among 'synced' jobs
 *   6) the sheet's own data row count + column M (technical id) uniqueness
 *   7) № sequence intact (1..N, no gaps/repeats)
 *
 * A single SELECT against sheet_sync_queue and one Google Sheets
 * values.get -- no other table, no writes anywhere.
 *
 * Never INSERTs/UPDATEs/DELETEs anything, never writes to Google Sheets,
 * never calls syncPassportRowToSheet(), never starts/restarts any worker or
 * service, never reads or changes SHEETS_SYNC_ENABLED (that is checked
 * separately, directly from .env, by the surrounding shell block -- not by
 * this script), never invokes any OCR provider.
 *
 * PRIVACY: only ids, enum status, attempts count, sheet_row_number, and
 * column-A/column-M values (row position + telegram_message_id, neither
 * PII) are printed -- no passport field, no last_error text.
 */
import { pool } from '../src/db/pool.js';
import { findGroupById } from '../src/db/repositories/groups.repo.js';
import { getSheetsClients } from '../src/sheets/sheetsAuth.js';
import { FIRST_DATA_ROW_NUMBER, TECHNICAL_ID_COLUMN_LETTER } from '../src/sheets/sheetLayout.js';

const GROUP_ID = 'c7e35e47-cb80-4816-abaf-2c96b57fe0d2';

interface QueueRow {
  id: string;
  telegram_message_id: string;
  status: string;
  attempts: number;
  sheet_row_number: number | null;
}

async function main(): Promise<void> {
  console.log('[final-audit] === 1) all sheet_sync_queue rows ===');
  const { rows } = await pool.query<QueueRow>(
    `SELECT id, telegram_message_id, status, attempts, sheet_row_number FROM sheet_sync_queue ORDER BY created_at`,
  );
  console.log('[final-audit] total rows:', rows.length);
  for (const row of rows) {
    console.log(
      `[final-audit]   id=${row.id}  telegram_message_id=${row.telegram_message_id}  status=${row.status}  ` +
        `attempts=${row.attempts}  sheet_row_number=${row.sheet_row_number ?? '(null)'}`,
    );
  }

  console.log('[final-audit] === 2) status counts ===');
  const statusCounts = new Map<string, number>();
  for (const status of ['pending', 'syncing', 'failed', 'synced']) statusCounts.set(status, 0);
  for (const row of rows) statusCounts.set(row.status, (statusCounts.get(row.status) ?? 0) + 1);
  for (const [status, count] of statusCounts) {
    console.log(`[final-audit]   ${status}: ${count}`);
  }

  console.log('[final-audit] === 3) any pending/syncing/failed job remaining? ===');
  const unresolvedCount = rows.filter((r) => r.status === 'pending' || r.status === 'syncing' || r.status === 'failed').length;
  console.log('[final-audit]   unresolved (pending+syncing+failed) count:', unresolvedCount);
  console.log('[final-audit]   ALL JOBS RESOLVED (no pending/syncing/failed remaining):', unresolvedCount === 0);

  console.log('[final-audit] === 4) any synced job with NULL sheet_row_number? ===');
  const syncedRows = rows.filter((r) => r.status === 'synced');
  const syncedWithNullRow = syncedRows.filter((r) => r.sheet_row_number === null);
  console.log('[final-audit]   synced jobs:', syncedRows.length);
  console.log('[final-audit]   synced jobs with NULL sheet_row_number:', syncedWithNullRow.length);
  if (syncedWithNullRow.length > 0) {
    console.log('[final-audit]   affected job ids:', syncedWithNullRow.map((r) => r.id));
  }

  console.log('[final-audit] === 5) sheet_row_number uniqueness among synced jobs ===');
  const rowNumbers = syncedRows.map((r) => r.sheet_row_number).filter((n): n is number => n !== null);
  const uniqueRowNumbers = new Set(rowNumbers);
  console.log('[final-audit]   sheet_row_number values:', rowNumbers.length, ' unique:', uniqueRowNumbers.size);
  console.log('[final-audit]   all sheet_row_numbers unique:', uniqueRowNumbers.size === rowNumbers.length);

  console.log('[final-audit] === 6/7) sheet data rows: count, column M uniqueness, № sequence ===');
  const group = await findGroupById(GROUP_ID);
  const spreadsheetId = group?.googleSheetId ?? null;
  if (!spreadsheetId) {
    console.log('[final-audit]   group has no google_sheet_id (unexpected) -- cannot continue sheet-side checks.');
  } else {
    console.log('[final-audit]   spreadsheetId:', spreadsheetId);
    const { sheets } = getSheetsClients();
    const range = `A${FIRST_DATA_ROW_NUMBER}:${TECHNICAL_ID_COLUMN_LETTER}`;
    const response = await sheets.spreadsheets.values.get({ spreadsheetId, range });
    const rawRows = response.data.values ?? [];
    const numberValues = rawRows.map((raw) => (typeof raw[0] === 'string' && raw[0].length > 0 ? Number(raw[0]) : null));
    const technicalIds = rawRows.map((raw) => (typeof raw[12] === 'string' && raw[12].length > 0 ? raw[12] : null)).filter((id): id is string => id !== null);
    const sequenceOk = numberValues.every((value, index) => value === index + 1);
    const uniqueOk = new Set(technicalIds).size === technicalIds.length;

    console.log('[final-audit]   total data rows in sheet:', rawRows.length);
    console.log('[final-audit]   column M non-empty ids:', technicalIds.length, ' unique:', new Set(technicalIds).size);
    console.log('[final-audit]   column M all unique:', uniqueOk);
    console.log('[final-audit]   № sequence intact (1..N):', sequenceOk, `values=[${numberValues.join(', ')}]`);
    console.log('[final-audit]   sheet row count matches synced job count:', rawRows.length === syncedRows.length);
  }

  console.log('[final-audit] DONE -- read-only, nothing was created, modified, or deleted.');
}

main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : 'unknown error';
    console.error('[final-audit] FAILED:', message.slice(0, 300));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
