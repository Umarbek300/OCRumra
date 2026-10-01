/**
 * TEMPORARY ONE-OFF DIAGNOSTIC — not part of the production OCR/Sheets
 * pipeline. Never imported by src/, never wired into any worker.
 *
 * Follow-up to tmp-diagnostic-sheets-per-job-spreadsheet-crosscheck.ts,
 * which just confirmed on real production data that all 14 synced jobs
 * share ONE group and ONE spreadsheet (disproving the "wrong spreadsheet
 * checked" hypothesis), yet NONE of their telegram_message_ids were found
 * in column M (index 12) of that spreadsheet's A2:M data. Earlier in this
 * same engagement, when only 5 jobs existed, column M WAS confirmed
 * correctly populated and matching for all 5 -- something changed since
 * then. The leading hypothesis is a manual edit to the sheet (an inserted
 * row or column) that shifted the technical id sideways out of the A:M
 * range this pipeline always reads/writes, rather than a code regression
 * (upsertRowInSheet.ts is unconditional about writing it -- see that
 * file's own doc comment).
 *
 * This script tests that directly and precisely:
 *  1) Prints the header row (A1:Z1) in full -- headers are never PII --
 *     to compare against sheetLayout.ts's own SHEET_HEADER_ROW.
 *  2) Reads the full data area A2:Z (26 columns, comfortably past M) for
 *     the group's own spreadsheet, resolved via the same
 *     queue -> telegram_message -> group -> google_sheet_id chain (no
 *     hardcoded GROUP_ID or spreadsheet id).
 *  3) For every synced job's exact telegram_message_id, searches EVERY
 *     column of EVERY data row for an exact match (not a generic UUID
 *     regex -- an exact match against the known id), reporting the exact
 *     row/column it was found at, or that it was not found anywhere in
 *     A:Z at all.
 *  4) Reports each data row's raw array length (Google Sheets omits
 *     trailing empty cells from values.get -- a row shorter than 13
 *     elements independently proves columns at/after that position are
 *     empty for that row, without needing to print their content).
 *
 * READ-ONLY: only SELECTs from Postgres and spreadsheets.values.get from
 * Google Sheets. Never writes anywhere, never starts/restarts any worker,
 * never touches SHEETS_SYNC_ENABLED, never invokes any OCR provider
 * (Tesseract or otherwise -- this project uses Google Cloud Vision only).
 *
 * PRIVACY: never prints passport-derived cell content. Only header text
 * (not PII), row lengths, column letters/indices, and telegram_message_id
 * UUIDs already known from the DB (not PII) are ever printed.
 */
import { pool } from '../src/db/pool.js';
import { getSheetsClients } from '../src/sheets/sheetsAuth.js';

interface QueueRow {
  id: string;
  telegram_message_id: string;
  sheet_row_number: number | null;
}

interface TelegramMessageRow {
  id: string;
  group_id: string | null;
}

interface GroupRow {
  id: string;
  google_sheet_id: string | null;
}

const SCAN_COLUMN_LETTERS = [
  'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M',
  'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z',
] as const;

async function main(): Promise<void> {
  console.log('[wide-scan] === 1) resolve the group + spreadsheet for all synced jobs (no hardcoded id) ===');
  const { rows: jobs } = await pool.query<QueueRow>(
    `SELECT id, telegram_message_id, sheet_row_number FROM sheet_sync_queue WHERE status = 'synced' ORDER BY created_at`,
  );
  console.log('[wide-scan] synced jobs:', jobs.length);
  if (jobs.length === 0) {
    console.log('[wide-scan] no synced jobs -- nothing to scan. DONE.');
    return;
  }

  const messageIds = jobs.map((j) => j.telegram_message_id);
  const { rows: messages } = await pool.query<TelegramMessageRow>(
    `SELECT id, group_id FROM telegram_messages WHERE id = ANY($1::uuid[])`,
    [messageIds],
  );
  const groupIdByMessageId = new Map(messages.map((m) => [m.id, m.group_id]));
  const groupIds = [...new Set(messages.map((m) => m.group_id).filter((id): id is string => id !== null))];

  const { rows: groups } = await pool.query<GroupRow>(
    `SELECT id, google_sheet_id FROM groups WHERE id = ANY($1::uuid[])`,
    [groupIds],
  );
  const spreadsheetIdByGroupId = new Map(groups.map((g) => [g.id, g.google_sheet_id]));

  const distinctSpreadsheets = [
    ...new Set(groups.map((g) => g.google_sheet_id).filter((id): id is string => id !== null)),
  ];
  console.log('[wide-scan] distinct spreadsheets resolved from synced jobs:', distinctSpreadsheets.length, distinctSpreadsheets);

  const { sheets } = getSheetsClients();

  for (const spreadsheetId of distinctSpreadsheets) {
    console.log(`\n[wide-scan] === spreadsheet ${spreadsheetId} ===`);

    console.log('[wide-scan] --- 2) header row (A1:Z1) -- not PII, printed in full ---');
    const headerResponse = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'A1:Z1' });
    const headerRow = headerResponse.data.values?.[0] ?? [];
    console.log('[wide-scan] header row length:', headerRow.length);
    for (let i = 0; i < headerRow.length; i++) {
      console.log(`[wide-scan]   ${SCAN_COLUMN_LETTERS[i] ?? `col${i}`}1: ${JSON.stringify(headerRow[i])}`);
    }

    console.log('[wide-scan] --- 3) data rows (A2:Z) -- row lengths + exact-id wide scan ---');
    const dataResponse = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'A2:Z' });
    const dataRows = (dataResponse.data.values ?? []) as string[][];
    console.log('[wide-scan] total data rows read:', dataRows.length);
    for (let r = 0; r < dataRows.length; r++) {
      console.log(`[wide-scan]   row ${r + 2}: length=${dataRows[r]!.length}  A(№)=${dataRows[r]![0] ?? '(empty)'}`);
    }

    console.log('[wide-scan] --- 4) exact telegram_message_id search across A:Z for every job resolved to this spreadsheet ---');
    let foundAnywhereCount = 0;
    let foundInMCount = 0;
    let foundElsewhereCount = 0;
    let notFoundAtAllCount = 0;

    for (const job of jobs) {
      const groupId = groupIdByMessageId.get(job.telegram_message_id);
      const jobSpreadsheetId = groupId ? spreadsheetIdByGroupId.get(groupId) : null;
      if (jobSpreadsheetId !== spreadsheetId) continue; // this job belongs to a different spreadsheet

      let foundAt: { row: number; column: string } | null = null;
      for (let r = 0; r < dataRows.length && !foundAt; r++) {
        const row = dataRows[r]!;
        for (let c = 0; c < row.length; c++) {
          if (row[c] === job.telegram_message_id) {
            foundAt = { row: r + 2, column: SCAN_COLUMN_LETTERS[c] ?? `col${c}` };
            break;
          }
        }
      }

      if (!foundAt) {
        notFoundAtAllCount += 1;
        console.log(
          `[wide-scan]   job=${job.id}  telegram_message_id=${job.telegram_message_id}  recorded_row=${job.sheet_row_number ?? '(null)'}  ` +
            `NOT FOUND anywhere in A:Z`,
        );
      } else {
        foundAnywhereCount += 1;
        if (foundAt.column === 'M') foundInMCount += 1;
        else foundElsewhereCount += 1;
        console.log(
          `[wide-scan]   job=${job.id}  telegram_message_id=${job.telegram_message_id}  recorded_row=${job.sheet_row_number ?? '(null)'}  ` +
            `FOUND at ${foundAt.column}${foundAt.row}  ${foundAt.column === 'M' ? '(expected column)' : '(UNEXPECTED column -- possible sheet shift)'}`,
        );
      }
    }

    console.log('[wide-scan] --- spreadsheet summary ---');
    console.log('[wide-scan]   found in column M (expected):', foundInMCount);
    console.log('[wide-scan]   found in a DIFFERENT column (sheet likely shifted):', foundElsewhereCount);
    console.log('[wide-scan]   not found anywhere in A:Z (genuinely missing):', notFoundAtAllCount);
    console.log('[wide-scan]   found anywhere (any column):', foundAnywhereCount);
  }

  console.log('\n[wide-scan] DONE -- read-only, nothing was created, modified, or deleted.');
}

main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : 'unknown error';
    console.error('[wide-scan] FAILED:', message.slice(0, 500));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
