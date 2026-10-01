/**
 * TEMPORARY ONE-OFF DIAGNOSTIC — not part of the production OCR/Sheets
 * pipeline. Never imported by src/, never wired into any worker.
 *
 * Controlled, single-job, manually-triggered end-to-end test of the real
 * Sheets sync pipeline for exactly ONE existing telegram_message + its
 * passport_ocr_results row. Uses ONLY existing, unmodified production
 * functions (enqueueSheetSync, syncPassportRowToSheet, findGroupById,
 * findSheetSyncQueueById) — no duplicated/new business logic.
 *
 * SAFETY / SCOPE:
 *  - Candidate selection (STEP 0) is a read-only SELECT that only accepts a
 *    telegram_message whose group has google_sheet_id IS NULL (so this run
 *    always creates a brand-new spreadsheet, never writes into an existing
 *    real one) and which has no sheet_sync_queue row yet (no collision with
 *    any other job).
 *  - DRY RUN BY DEFAULT: everything past STEP 0 only happens if the
 *    CONFIRM_E2E_WRITE=yes environment variable is set on invocation. Run
 *    with no env var to just see which candidate would be used, at zero
 *    risk.
 *  - Never bypasses SHEETS_SYNC_ENABLED as a "hack": that flag is only ever
 *    read inside runSheetSyncLoop.ts's own poll loop
 *    (`deps.isEnabled()` before `findDue()`), never inside
 *    syncPassportRowToSheet.ts. Calling syncPassportRowToSheet() directly,
 *    once, from a one-off script is calling the same already-tested unit
 *    the test suite itself calls directly — it does not touch, read, or
 *    need that flag at all.
 *  - Never starts runSheetSyncLoop/src/sheets/start.ts — this process runs
 *    once and exits, nothing is left polling.
 *  - Never logs actual passport/OCR field values (name, passport number,
 *    dates, gender, agent, package, deposit) — only ids, row numbers,
 *    booleans ("cell is non-empty"), and the two columns that are not
 *    sensitive (№ and the technical telegram_message_id column M). Same
 *    discipline syncPassportRowToSheet.ts itself already documents.
 *  - Never deletes the created spreadsheet — prints its id/URL for manual
 *    review in Drive; cleanup (if wanted) is a separate, later, manual step.
 *  - The one non-standard DB action (STEP 7's idempotency re-test) resets
 *    ONLY the single sheet_sync_queue row this same run created, by its own
 *    primary-key id — cannot affect any other row.
 */
import { pool } from '../src/db/pool.js';
import { findGroupById } from '../src/db/repositories/groups.repo.js';
import { enqueueSheetSync, findSheetSyncQueueById } from '../src/db/repositories/sheetSyncQueue.repo.js';
import { getConfiguredDriveFolderId, getSheetsClients } from '../src/sheets/sheetsAuth.js';
import { fullRowRange, HEADER_RANGE_A1, SHEET_HEADER_ROW } from '../src/sheets/sheetLayout.js';
import { syncPassportRowToSheet } from '../src/sheets/syncPassportRowToSheet.js';

const CONFIRM = process.env.CONFIRM_E2E_WRITE === 'yes';

interface Candidate {
  telegramMessageId: string;
  groupId: string;
  groupName: string;
  ocrResultId: string;
}

async function findCandidate(): Promise<Candidate | null> {
  const { rows } = await pool.query<{
    telegram_message_id: string;
    group_id: string;
    group_name: string;
    ocr_result_id: string;
  }>(
    `SELECT tm.id AS telegram_message_id, tm.group_id, g.name AS group_name, por.id AS ocr_result_id
     FROM telegram_messages tm
     JOIN passport_ocr_results por ON por.telegram_message_id = tm.id
     JOIN groups g ON g.id = tm.group_id
     LEFT JOIN sheet_sync_queue ssq ON ssq.telegram_message_id = tm.id
     WHERE tm.group_id IS NOT NULL
       AND g.google_sheet_id IS NULL
       AND ssq.id IS NULL
     ORDER BY tm.created_at DESC
     LIMIT 1`,
  );
  const row = rows[0];
  if (!row) return null;
  return {
    telegramMessageId: row.telegram_message_id,
    groupId: row.group_id,
    groupName: row.group_name,
    ocrResultId: row.ocr_result_id,
  };
}

function cellNonEmpty(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0;
}

async function main(): Promise<void> {
  console.log('[sheets-e2e] === STEP 0: selecting a candidate (read-only) ===');
  const candidate = await findCandidate();
  if (!candidate) {
    console.log('[sheets-e2e] no eligible candidate found (need a telegram_message with a passport_ocr_results row, ' +
      'whose group has google_sheet_id IS NULL, and no existing sheet_sync_queue row) -- nothing to test.');
    return;
  }
  console.log('[sheets-e2e] candidate:', candidate);

  if (!CONFIRM) {
    console.log('[sheets-e2e] DRY RUN (CONFIRM_E2E_WRITE is not "yes") -- stopping here. Nothing was written.');
    console.log('[sheets-e2e] re-run with CONFIRM_E2E_WRITE=yes to actually enqueue + sync this one job.');
    return;
  }

  console.log('[sheets-e2e] === STEP 1: enqueueSheetSync (real production function, one INSERT) ===');
  const job = await enqueueSheetSync(candidate.telegramMessageId);
  if (!job) {
    console.log('[sheets-e2e] enqueueSheetSync returned null (a job already existed) -- stopping, not touching it.');
    return;
  }
  console.log('[sheets-e2e] job created:', { id: job.id, status: job.status, attempts: job.attempts });

  console.log('[sheets-e2e] === STEP 2: syncPassportRowToSheet (the SAME function the real worker calls) ===');
  await syncPassportRowToSheet(job.id);

  const afterFirstSync = await findSheetSyncQueueById(job.id);
  if (!afterFirstSync || afterFirstSync.status !== 'synced') {
    console.log('[sheets-e2e] FIRST SYNC DID NOT SUCCEED -- stopping before any further checks:', afterFirstSync);
    return;
  }
  console.log('[sheets-e2e] job synced:', {
    status: afterFirstSync.status,
    attempts: afterFirstSync.attempts,
    sheetRowNumber: afterFirstSync.sheetRowNumber,
  });

  const group = await findGroupById(candidate.groupId);
  const spreadsheetId = group?.googleSheetId ?? null;
  if (!spreadsheetId) {
    console.log('[sheets-e2e] FAILED -- group has no google_sheet_id after a synced job (unexpected).');
    return;
  }
  console.log('[sheets-e2e] spreadsheetId:', spreadsheetId);
  console.log('[sheets-e2e] spreadsheet URL (for manual review in Drive):', `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`);

  const { sheets, drive } = getSheetsClients();

  console.log('[sheets-e2e] === STEP 3: is the spreadsheet inside the configured OCR_sheets folder? (read-only) ===');
  const folderId = getConfiguredDriveFolderId();
  const fileMeta = await drive.files.get({ fileId: spreadsheetId, fields: 'id, name, parents' });
  const parents = fileMeta.data.parents ?? [];
  console.log('[sheets-e2e] spreadsheet parents:', parents, 'expected folder:', folderId);
  console.log('[sheets-e2e] STEP 3 result: inside configured folder =', folderId != null && parents.includes(folderId));

  console.log('[sheets-e2e] === STEP 4: header row has exactly the 12 visible columns + 1 technical column? (read-only) ===');
  const headerResp = await sheets.spreadsheets.values.get({ spreadsheetId, range: HEADER_RANGE_A1 });
  const headerRow = headerResp.data.values?.[0] ?? [];
  const headerMatches = JSON.stringify(headerRow) === JSON.stringify(SHEET_HEADER_ROW);
  console.log('[sheets-e2e] header row (safe to print -- these are column titles, not passport data):', headerRow);
  console.log('[sheets-e2e] STEP 4 result: header matches SHEET_HEADER_ROW exactly =', headerMatches);

  console.log('[sheets-e2e] === STEP 5/6: exactly one data row, and the M technical column holds this telegram_message_id? (read-only) ===');
  const row2Resp = await sheets.spreadsheets.values.get({ spreadsheetId, range: fullRowRange(2) });
  const row2 = row2Resp.data.values?.[0] ?? [];
  const rowNumberCell = row2[0] ?? null;
  const technicalIdCell = row2[12] ?? null;
  const visibleCellsNonEmpty = row2.slice(1, 11).map(cellNonEmpty);
  console.log('[sheets-e2e] row 2, № (safe, not PII):', rowNumberCell);
  console.log('[sheets-e2e] row 2, visible columns B..K non-empty? (booleans only, values never printed):', visibleCellsNonEmpty);
  console.log('[sheets-e2e] row 2, technical column M (telegram_message_id, not a secret):', technicalIdCell);
  console.log('[sheets-e2e] STEP 6 result: M column matches this job\'s telegram_message_id =', technicalIdCell === candidate.telegramMessageId);

  console.log('[sheets-e2e] === STEP 7: idempotency -- re-run the SAME job, expect an UPDATE in place, never a new row ===');
  await pool.query(`UPDATE sheet_sync_queue SET status = 'pending', next_attempt_at = now() WHERE id = $1`, [job.id]);
  await syncPassportRowToSheet(job.id);

  const afterSecondSync = await findSheetSyncQueueById(job.id);
  console.log('[sheets-e2e] job after second sync:', {
    status: afterSecondSync?.status,
    attempts: afterSecondSync?.attempts,
    sheetRowNumber: afterSecondSync?.sheetRowNumber,
  });

  const row3Resp = await sheets.spreadsheets.values.get({ spreadsheetId, range: fullRowRange(3) });
  const row3 = row3Resp.data.values?.[0] ?? [];
  console.log('[sheets-e2e] STEP 7 result: row 3 is still empty (no duplicate appended) =', row3.length === 0);

  console.log('[sheets-e2e] === STEP 8: final sheet_sync_queue status ===');
  console.log('[sheets-e2e] STEP 8 result: status =', afterSecondSync?.status, '(expected "synced")');

  console.log('[sheets-e2e] === STEP 9: cleanup policy ===');
  console.log('[sheets-e2e] the created spreadsheet was NOT deleted -- review it at the URL above, then decide separately.');
  console.log(`[sheets-e2e] to identify it later: group_id=${candidate.groupId}, telegram_message_id=${candidate.telegramMessageId}, sheet_sync_queue_id=${job.id}`);

  console.log('[sheets-e2e] DONE.');
}

main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : 'unknown error';
    console.error('[sheets-e2e] FAILED:', message.slice(0, 300));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
