/**
 * TEMPORARY ONE-OFF DIAGNOSTIC — not part of the production OCR/Sheets
 * pipeline. Never imported by src/, never wired into any worker.
 *
 * Purpose: after tmp-diagnostic-enqueue-single-retest-candidate.ts created
 * exactly one new sheet_sync_queue row (id=1ffa3b23-0ede-4767-b665-
 * 3a3a58888b35, telegram_message_id=52e2bbfe-7a24-4b44-bde9-95ddb904a200,
 * initial status='pending'), this verifies -- entirely by READING -- whether
 * the already-running ocrumra-sheets-sync.service picked that job up on its
 * own normal polling cycle and processed it correctly with the deterministic
 * upsertRowInSheet.ts fix, and that nothing else was disturbed.
 *
 * How it waits for the worker: this script does NOT start, stop, restart,
 * or signal any service. It only re-SELECTs the target row from Postgres
 * every POLL_INTERVAL_MS, up to MAX_POLL_ATTEMPTS times, stopping early the
 * moment the row leaves 'pending'/'syncing' (i.e. reaches a terminal state
 * 'synced' or 'failed'). This is pure observation of state the already-
 * running worker changes by itself on its own schedule.
 *
 * READ-ONLY, end to end:
 *   - Postgres: only SELECT statements (sheet_sync_queue, telegram_messages,
 *     groups). No INSERT/UPDATE/DELETE anywhere in this file.
 *   - Google Sheets: only spreadsheets.values.get (read), called twice with
 *     a short delay to confirm the written value persists identically on a
 *     second, independent read (acceptance criterion F). Never
 *     values.update/values.append/spreadsheets.get-for-provisioning -- if
 *     the group's sheet were somehow not yet provisioned (google_sheet_id
 *     IS NULL) this script explicitly reports that and stops, rather than
 *     calling ensureGroupSheet (which can create a new Drive file/tab as a
 *     side effect and is therefore not read-only).
 *   - No service is started/stopped/restarted. No queue status is written.
 *     No Tesseract/local OCR is invoked.
 *
 * PRIVACY: for the target row's actual Sheet content, only BOOLEAN
 * "is this cell non-empty" per visible column (A:L) is printed, plus the
 * technical column M's own value (safe to print in full -- it is just the
 * telegram_message_id UUID this whole pipeline already keys on, never
 * passport/OCR content). No real passport field value is ever logged.
 */
import { pool } from '../src/db/pool.js';
import { getSheetsClients } from '../src/sheets/sheetsAuth.js';
import { fullRowRange, VISIBLE_COLUMN_HEADERS } from '../src/sheets/sheetLayout.js';

const TARGET_QUEUE_ID = '1ffa3b23-0ede-4767-b665-3a3a58888b35';
const TARGET_TELEGRAM_MESSAGE_ID = '52e2bbfe-7a24-4b44-bde9-95ddb904a200';
const POLL_INTERVAL_MS = 5000;
const MAX_POLL_ATTEMPTS = 24; // ~2 minutes total

interface QueueStateRow {
  id: string;
  status: string;
  sheet_row_number: number | null;
  synced_at: string | null;
  last_error: string | null;
  attempts: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchQueueState(): Promise<QueueStateRow> {
  const { rows } = await pool.query<QueueStateRow>(
    `SELECT id, status, sheet_row_number, synced_at, last_error, attempts
     FROM sheet_sync_queue WHERE id = $1`,
    [TARGET_QUEUE_ID],
  );
  const row = rows[0];
  if (!row) {
    throw new Error(`target queue row ${TARGET_QUEUE_ID} no longer exists`);
  }
  return row;
}

async function pollUntilTerminal(): Promise<QueueStateRow> {
  console.log('[verify-single-candidate] === polling target queue row (read-only, no writes, no restarts) ===');
  let state = await fetchQueueState();
  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt += 1) {
    console.log(
      `[verify-single-candidate]   poll #${attempt}: status=${state.status}  sheet_row_number=${state.sheet_row_number ?? '(none)'}  ` +
        `synced_at=${state.synced_at ?? '(none)'}  attempts=${state.attempts}  last_error_present=${state.last_error !== null}`,
    );
    if (state.status === 'synced' || state.status === 'failed') {
      return state;
    }
    await sleep(POLL_INTERVAL_MS);
    state = await fetchQueueState();
  }
  console.log('[verify-single-candidate]   gave up waiting after max poll attempts -- job still not in a terminal state.');
  return state;
}

interface GroupSheetRow {
  group_id: string;
  google_sheet_id: string | null;
}

async function fetchGroupSheetId(): Promise<GroupSheetRow | null> {
  const { rows } = await pool.query<GroupSheetRow>(
    `SELECT g.id AS group_id, g.google_sheet_id
     FROM telegram_messages tm
     JOIN groups g ON g.id = tm.group_id
     WHERE tm.id = $1`,
    [TARGET_TELEGRAM_MESSAGE_ID],
  );
  return rows[0] ?? null;
}

async function readSheetRow(spreadsheetId: string, rowNumber: number): Promise<string[]> {
  const { sheets } = getSheetsClients();
  const response = await sheets.spreadsheets.values.get({ spreadsheetId, range: fullRowRange(rowNumber) });
  const values = response.data.values ?? [];
  return (values[0] ?? []) as string[];
}

function describeRow(row: string[]): void {
  VISIBLE_COLUMN_HEADERS.forEach((header: string, index: number) => {
    const cell = row[index];
    console.log(`[verify-single-candidate]     column ${String.fromCharCode(65 + index)} (${header}): non_empty=${!!cell && cell.length > 0}`);
  });
  const technicalIdCell = row[12] ?? '';
  console.log(`[verify-single-candidate]     column M (technical id): value=${technicalIdCell}`);
  console.log(`[verify-single-candidate]     column M equals target telegram_message_id: ${technicalIdCell === TARGET_TELEGRAM_MESSAGE_ID}`);
}

interface OtherSyncedRow {
  id: string;
  telegram_message_id: string;
  sheet_row_number: number | null;
}

async function checkOtherSyncedJobsUnaffected(): Promise<void> {
  console.log('[verify-single-candidate] === are all OTHER synced jobs still consistent (no duplicate/colliding sheet_row_number)? ===');
  const { rows } = await pool.query<OtherSyncedRow>(
    `SELECT id, telegram_message_id, sheet_row_number
     FROM sheet_sync_queue
     WHERE status = 'synced' AND id != $1
     ORDER BY sheet_row_number`,
    [TARGET_QUEUE_ID],
  );
  console.log(`[verify-single-candidate]   other synced jobs (excluding target): ${rows.length}`);

  const rowNumberCounts = new Map<number, number>();
  for (const r of rows) {
    if (r.sheet_row_number === null) continue;
    rowNumberCounts.set(r.sheet_row_number, (rowNumberCounts.get(r.sheet_row_number) ?? 0) + 1);
  }
  const duplicates = [...rowNumberCounts.entries()].filter(([, count]) => count > 1);
  console.log(`[verify-single-candidate]   duplicate sheet_row_number values among other synced jobs: ${duplicates.length}`);
  for (const [rowNumber, count] of duplicates) {
    console.log(`[verify-single-candidate]     sheet_row_number=${rowNumber} shared by ${count} jobs`);
  }

  const { rows: statusCounts } = await pool.query<{ status: string; count: string }>(
    `SELECT status, COUNT(*)::text AS count FROM sheet_sync_queue GROUP BY status ORDER BY status`,
  );
  console.log('[verify-single-candidate]   current overall sheet_sync_queue status counts:');
  for (const s of statusCounts) {
    console.log(`[verify-single-candidate]     ${s.status}: ${s.count}`);
  }
}

async function main(): Promise<void> {
  const finalState = await pollUntilTerminal();

  console.log('[verify-single-candidate] === target job final state ===');
  console.log(
    `[verify-single-candidate]   status=${finalState.status}  sheet_row_number=${finalState.sheet_row_number ?? '(none)'}  ` +
      `synced_at=${finalState.synced_at ?? '(none)'}  last_error_present=${finalState.last_error !== null}`,
  );
  if (finalState.last_error !== null) {
    console.log(`[verify-single-candidate]   last_error (sanitized, already bounded by the pipeline itself): ${finalState.last_error}`);
  }

  if (finalState.status !== 'synced' || finalState.sheet_row_number === null) {
    console.log(
      '[verify-single-candidate] Target job is not yet synced with a row number -- skipping Sheet-side checks for now. ' +
        'Nothing was written or restarted; re-run this same script later to check again.',
    );
    await checkOtherSyncedJobsUnaffected();
    console.log('[verify-single-candidate] DONE -- read-only, nothing was created, modified, or deleted.');
    return;
  }

  console.log('[verify-single-candidate] === resolving the group\'s spreadsheet id (read-only; will NOT provision one if missing) ===');
  const groupSheet = await fetchGroupSheetId();
  if (!groupSheet || !groupSheet.google_sheet_id) {
    console.log('[verify-single-candidate]   group has no google_sheet_id on record -- cannot verify Sheet content. Stopping (no provisioning attempted).');
    await checkOtherSyncedJobsUnaffected();
    console.log('[verify-single-candidate] DONE -- read-only, nothing was created, modified, or deleted.');
    return;
  }
  const spreadsheetId = groupSheet.google_sheet_id;
  console.log(`[verify-single-candidate]   spreadsheetId resolved (value withheld from this log; present=${spreadsheetId.length > 0})`);

  console.log(`[verify-single-candidate] === reading physical Sheet row ${finalState.sheet_row_number} (read #1) ===`);
  const firstRead = await readSheetRow(spreadsheetId, finalState.sheet_row_number);
  describeRow(firstRead);

  console.log('[verify-single-candidate] === waiting 2s, then reading the SAME row again (read #2, confirms persistence) ===');
  await sleep(2000);
  const secondRead = await readSheetRow(spreadsheetId, finalState.sheet_row_number);
  describeRow(secondRead);

  const identical = JSON.stringify(firstRead) === JSON.stringify(secondRead);
  console.log(`[verify-single-candidate]   read #1 and read #2 are byte-for-byte identical: ${identical}`);

  await checkOtherSyncedJobsUnaffected();

  console.log('[verify-single-candidate] === acceptance criteria summary (computed from the checks above) ===');
  const technicalIdMatches = (firstRead[12] ?? '') === TARGET_TELEGRAM_MESSAGE_ID;
  const hasVisibleData = VISIBLE_COLUMN_HEADERS.some((_: string, index: number) => !!firstRead[index] && firstRead[index]!.length > 0);
  console.log(`[verify-single-candidate]   A. target job status === 'synced': ${finalState.status === 'synced'}`);
  console.log(`[verify-single-candidate]   B. sheet_row_number present: ${finalState.sheet_row_number !== null}`);
  console.log(`[verify-single-candidate]   C. physical row A:L has at least one non-empty cell: ${hasVisibleData}`);
  console.log(`[verify-single-candidate]   D. column M === target telegram_message_id: ${technicalIdMatches}`);
  console.log('[verify-single-candidate]   E. DB sheet_row_number matches the row actually read above: true (same number was used for both)');
  console.log(`[verify-single-candidate]   F. value persists identically on re-read: ${identical}`);
  console.log('[verify-single-candidate]   G. see "other synced jobs" duplicate check above -- 0 duplicates means no collision was introduced');

  console.log('[verify-single-candidate] DONE -- read-only, nothing was created, modified, or deleted.');
}

main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : 'unknown error';
    console.error('[verify-single-candidate] FAILED:', message.slice(0, 500));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
