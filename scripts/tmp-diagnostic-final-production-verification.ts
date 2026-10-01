/**
 * TEMPORARY ONE-OFF DIAGNOSTIC — not part of the production OCR/Sheets
 * pipeline. Never imported by src/, never wired into any worker.
 *
 * Purpose: FINAL production verification for the Sheets-sync deterministic
 * fix. Covers sections C (current physical Sheet state) and D (queue
 * consistency) of the requested verification. Sections A (source hash /
 * values.append absence) and B (typecheck) are plain read-only bash/tsc
 * commands run alongside this script, not inside it.
 *
 * READ-ONLY, end to end:
 *   - Google Sheets: only spreadsheets.get (metadata) and spreadsheets.
 *     values.get("A2:M") (a single read). Never values.update, never
 *     values.append, never any provisioning/write call.
 *   - Postgres: only SELECT statements against sheet_sync_queue. No
 *     INSERT/UPDATE/DELETE anywhere in this file.
 *   - No service is started/stopped/restarted. No Tesseract/local OCR.
 *
 * PRIVACY: column A (row sequence numbers) and column M (technical
 * telegram_message_id) are the only Sheet cell values printed -- neither is
 * passport PII. Columns B:L are reported only as non-empty/empty booleans,
 * never their literal text. DB output is ids, statuses, timestamps,
 * attempts, and counts only.
 */
import { pool } from '../src/db/pool.js';
import { getSheetsClients } from '../src/sheets/sheetsAuth.js';

const SPREADSHEET_ID = '16oTz3UkPqYIlyiqk3Gv-4CA9Le1uIw0DSeO7ItecPWs';
const RETEST_TELEGRAM_MESSAGE_ID = '52e2bbfe-7a24-4b44-bde9-95ddb904a200';
const RETEST_EXPECTED_ROW_NUMBER = 5;
const POST_PATCH_CUTOFF_ISO = '2026-09-28T07:54:00.000Z';

async function checkSheetsState(): Promise<void> {
  console.log('[final-verify] === C) current Sheets state ===');
  const { sheets } = getSheetsClients();

  let spreadsheetExists = false;
  let sheet1Exists = false;
  try {
    const metadata = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID, fields: 'properties.title,sheets.properties' });
    spreadsheetExists = true;
    sheet1Exists = (metadata.data.sheets ?? []).some((s) => s.properties?.title === 'Sheet1');
    console.log(`[final-verify]   spreadsheet exists: ${spreadsheetExists}`);
    console.log(`[final-verify]   Sheet1 tab exists: ${sheet1Exists}`);
  } catch (error) {
    console.log(`[final-verify]   spreadsheets.get FAILED: ${error instanceof Error ? error.message.slice(0, 300) : 'unknown error'}`);
  }

  const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'A2:M' });
  const rows = (response.data.values ?? []) as string[][];
  console.log(`[final-verify]   A2:M real data-row count (values.get array length): ${rows.length}`);

  const mIds = rows.map((row) => row[12] ?? '');
  const nonEmptyMIds = mIds.filter((id) => id.length > 0);
  console.log(`[final-verify]   column M non-empty ID count: ${nonEmptyMIds.length}`);

  const mIdCounts = new Map<string, number>();
  for (const id of nonEmptyMIds) {
    mIdCounts.set(id, (mIdCounts.get(id) ?? 0) + 1);
  }
  const duplicateMIds = [...mIdCounts.entries()].filter(([, count]) => count > 1);
  console.log(`[final-verify]   column M IDs unique: ${duplicateMIds.length === 0}`);
  console.log(`[final-verify]   duplicate M ID count: ${duplicateMIds.length}`);
  for (const [id, count] of duplicateMIds) {
    console.log(`[final-verify]     duplicate: M=${id} appears ${count} times`);
  }

  let sequenceOk = true;
  const sequenceMismatches: string[] = [];
  rows.forEach((row, index) => {
    const expected = String(index + 1);
    const actual = row[0] ?? '';
    if (actual !== expected) {
      sequenceOk = false;
      sequenceMismatches.push(`row ${index + 2}: expected №=${expected} actual №=${actual || '(empty)'}`);
    }
  });
  console.log(`[final-verify]   column A (№) sequential for current data rows: ${sequenceOk}`);
  for (const mismatch of sequenceMismatches) {
    console.log(`[final-verify]     ${mismatch}`);
  }

  const retestRow = rows[RETEST_EXPECTED_ROW_NUMBER - 2]; // row 5 => index 3 (row 2 = index 0)
  const retestMValue = retestRow?.[12] ?? '';
  const retestMatches = retestMValue === RETEST_TELEGRAM_MESSAGE_ID;
  console.log(`[final-verify]   retest row ${RETEST_EXPECTED_ROW_NUMBER} M value matches target telegram_message_id: ${retestMatches}`);
  if (!retestMatches) {
    console.log(`[final-verify]     physical M${RETEST_EXPECTED_ROW_NUMBER} value: ${retestMValue || '(empty)'}`);
  }
}

interface StatusCountRow {
  status: string;
  count: string;
}

interface NullRowNumberRow {
  count: string;
}

interface DuplicateRowNumberRow {
  sheet_row_number: number;
  count: string;
}

interface PostPatchJobRow {
  id: string;
  status: string;
  attempts: number;
  sheet_row_number: number | null;
  synced_at: Date | string | null;
}

async function checkQueueConsistency(): Promise<void> {
  console.log('[final-verify] === D) queue consistency ===');

  const { rows: statusCounts } = await pool.query<StatusCountRow>(
    `SELECT status, COUNT(*)::text AS count FROM sheet_sync_queue GROUP BY status ORDER BY status`,
  );
  console.log('[final-verify]   sheet_sync_queue status summary:');
  for (const s of statusCounts) {
    console.log(`[final-verify]     ${s.status}: ${s.count}`);
  }

  const { rows: nullRowNumberRows } = await pool.query<NullRowNumberRow>(
    `SELECT COUNT(*)::text AS count FROM sheet_sync_queue WHERE status = 'synced' AND sheet_row_number IS NULL`,
  );
  console.log(`[final-verify]   synced jobs with sheet_row_number IS NULL: ${nullRowNumberRows[0]?.count ?? '0'}`);

  const { rows: duplicateRowNumbers } = await pool.query<DuplicateRowNumberRow>(
    `SELECT sheet_row_number, COUNT(*)::text AS count
     FROM sheet_sync_queue
     WHERE status = 'synced' AND sheet_row_number IS NOT NULL
     GROUP BY sheet_row_number
     HAVING COUNT(*) > 1
     ORDER BY sheet_row_number`,
  );
  console.log(`[final-verify]   duplicate sheet_row_number count (among synced jobs): ${duplicateRowNumbers.length}`);
  for (const d of duplicateRowNumbers) {
    console.log(`[final-verify]     sheet_row_number=${d.sheet_row_number} shared by ${d.count} jobs`);
  }

  const { rows: postPatchJobs } = await pool.query<PostPatchJobRow>(
    `SELECT id, status, attempts, sheet_row_number, synced_at
     FROM sheet_sync_queue
     WHERE synced_at >= $1
     ORDER BY synced_at`,
    [POST_PATCH_CUTOFF_ISO],
  );
  console.log(`[final-verify]   jobs synced at/after ${POST_PATCH_CUTOFF_ISO}: ${postPatchJobs.length}`);
  for (const j of postPatchJobs) {
    console.log(
      `[final-verify]     queue_id=${j.id}  status=${j.status}  attempts=${j.attempts}  sheet_row_number=${j.sheet_row_number ?? '(none)'}  synced_at=${j.synced_at ?? '(none)'}`,
    );
  }

  const postPatchRowNumberCounts = new Map<number, number>();
  for (const j of postPatchJobs) {
    if (j.sheet_row_number === null) continue;
    postPatchRowNumberCounts.set(j.sheet_row_number, (postPatchRowNumberCounts.get(j.sheet_row_number) ?? 0) + 1);
  }
  const postPatchCollisions = [...postPatchRowNumberCounts.entries()].filter(([, count]) => count > 1);
  console.log(`[final-verify]   collisions AMONG post-patch jobs only (row numbers shared by >1 post-patch job): ${postPatchCollisions.length}`);
  for (const [rowNumber, count] of postPatchCollisions) {
    console.log(`[final-verify]     sheet_row_number=${rowNumber} shared by ${count} post-patch jobs`);
  }
}

async function main(): Promise<void> {
  await checkSheetsState();
  await checkQueueConsistency();
  console.log('[final-verify] DONE -- read-only, nothing was created, modified, or deleted.');
}

main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : 'unknown error';
    console.error('[final-verify] FAILED:', message.slice(0, 500));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
