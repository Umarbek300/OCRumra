/**
 * TEMPORARY ONE-OFF DIAGNOSTIC — not part of the production OCR/Sheets
 * pipeline. Never imported by src/, never wired into any worker.
 *
 * Purpose: the user reports that AFTER deploying the deterministic
 * upsertRowInSheet.ts fix and restarting ocrumra-sheets-sync.service, the
 * SAME symptom persists -- 15 synced jobs, none of their telegram_message_
 * ids found in column M, A:L blank, M full of pollution (AI text,
 * "DIAG-TEST", "16"). Before concluding the fix itself is defective, this
 * checks the two most likely alternative explanations, both purely
 * read-only:
 *
 *   1) STALE DATA: were these 15 jobs already marked 'synced' BEFORE the
 *      fixed code was actually running? If every affected job's synced_at
 *      predates the sheets-sync process's own start time, the fix can be
 *      live and correct while these 15 rows remain exactly as the OLD,
 *      buggy code left them -- the fix only governs FUTURE writes, it
 *      cannot retroactively repair rows already written incorrectly.
 *   2) WRONG TAB: our own Sheets ranges (e.g. "A2:M") never include a
 *      sheet/tab name prefix, so they always target whichever tab Google
 *      considers first (lowest sheetId/index) in the spreadsheet. If this
 *      spreadsheet has more than one tab, and the human-visible "Sheet1"
 *      is NOT that first tab, a human checking "Sheet1" and our own code
 *      could be looking at two different tabs entirely, whatever
 *      individually written to. This checks the spreadsheet's actual tab
 *      list via spreadsheets.get (metadata only, never reads/writes cell
 *      values), which cannot be confirmed or ruled out from source code
 *      alone.
 *
 * READ-ONLY: only SELECTs from Postgres, reads the sheets-sync source file
 * from disk, inspects the running process via /proc, and calls
 * spreadsheets.get (metadata only). Never INSERTs/UPDATEs/DELETEs
 * anything, never writes a single Sheets cell, never starts/stops/restarts
 * any service, never touches SHEETS_SYNC_ENABLED, never invokes any OCR
 * provider (Tesseract or otherwise -- this project uses Google Cloud
 * Vision only).
 *
 * PRIVACY: only ids, timestamps, status, row numbers, and sheet/tab
 * metadata (never cell content) are printed. No passport field is ever
 * logged.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pool } from '../src/db/pool.js';
import { getSheetsClients } from '../src/sheets/sheetsAuth.js';

const KNOWN_FIXED_UPSERT_ROW_SHA256 = '7fb0a88d796035b426ff1db1eea1e3da3243f40fd1cf2856a963f97e04057d09';
const SHEET_SYNC_SERVICE = 'ocrumra-sheets-sync.service';

async function checkProcessAndSourceHash(): Promise<Date | null> {
  console.log('[post-fix-verify] === 1) is the deterministic fix actually the code running right now? ===');

  let mainPid: string | null = null;
  let startTime: Date | null = null;
  try {
    const activeState = execSync(`systemctl show ${SHEET_SYNC_SERVICE} -p ActiveState --value`, { encoding: 'utf8' }).trim();
    const subState = execSync(`systemctl show ${SHEET_SYNC_SERVICE} -p SubState --value`, { encoding: 'utf8' }).trim();
    mainPid = execSync(`systemctl show ${SHEET_SYNC_SERVICE} -p MainPID --value`, { encoding: 'utf8' }).trim();
    const startTimeRaw = execSync(`systemctl show ${SHEET_SYNC_SERVICE} -p ActiveEnterTimestamp --value`, { encoding: 'utf8' }).trim();
    console.log(`[post-fix-verify]   ActiveState=${activeState} SubState=${subState} MainPID=${mainPid}`);
    console.log(`[post-fix-verify]   ActiveEnterTimestamp (last start/restart time)=${startTimeRaw}`);
    startTime = startTimeRaw ? new Date(startTimeRaw) : null;
  } catch (error) {
    console.log('[post-fix-verify]   systemctl query failed:', error instanceof Error ? error.message.slice(0, 200) : 'unknown error');
  }

  try {
    const fileContent = readFileSync('/opt/OCRumra/src/sheets/upsertRowInSheet.ts', 'utf8');
    const actualHash = createHash('sha256').update(fileContent).digest('hex');
    const matches = actualHash === KNOWN_FIXED_UPSERT_ROW_SHA256;
    console.log(`[post-fix-verify]   on-disk upsertRowInSheet.ts sha256=${actualHash}`);
    console.log(`[post-fix-verify]   matches the known-fixed (deterministic) version: ${matches}`);
  } catch (error) {
    console.log('[post-fix-verify]   could not read upsertRowInSheet.ts:', error instanceof Error ? error.message : 'unknown error');
  }

  return startTime;
}

interface QueueRow {
  id: string;
  telegram_message_id: string;
  status: string;
  sheet_row_number: number | null;
  synced_at: string | null;
}

async function checkSyncedAtVsProcessStart(processStartTime: Date | null): Promise<void> {
  console.log('[post-fix-verify] === 2) were these jobs synced BEFORE or AFTER the sheets-sync process last started? ===');
  const { rows } = await pool.query<QueueRow>(
    `SELECT id, telegram_message_id, status, sheet_row_number, synced_at
     FROM sheet_sync_queue WHERE status = 'synced' ORDER BY synced_at`,
  );
  console.log('[post-fix-verify]   synced jobs:', rows.length);

  if (!processStartTime) {
    console.log('[post-fix-verify]   process start time unknown (see section 1) -- cannot compare, listing raw synced_at only:');
    for (const r of rows) {
      console.log(`[post-fix-verify]     job=${r.id}  sheet_row_number=${r.sheet_row_number}  synced_at=${r.synced_at}`);
    }
    return;
  }

  let beforeCount = 0;
  let afterCount = 0;
  for (const r of rows) {
    const syncedAt = r.synced_at ? new Date(r.synced_at) : null;
    const isBefore = syncedAt ? syncedAt.getTime() < processStartTime.getTime() : null;
    if (isBefore === true) beforeCount += 1;
    if (isBefore === false) afterCount += 1;
    console.log(
      `[post-fix-verify]     job=${r.id}  sheet_row_number=${r.sheet_row_number}  synced_at=${r.synced_at}  ` +
        `synced_before_current_process_start=${isBefore}`,
    );
  }
  console.log(`[post-fix-verify]   TOTAL: synced BEFORE current process start=${beforeCount}  synced AFTER=${afterCount}`);
  console.log(
    '[post-fix-verify]   NOTE: if ALL affected jobs were synced BEFORE the current process start, they were written by ' +
      'whatever code was running at that earlier time -- the current (possibly fixed) code has never touched them, and ' +
      'restarting the service does not retroactively repair rows already written.',
  );
}

async function checkSpreadsheetTabs(spreadsheetId: string): Promise<void> {
  console.log('[post-fix-verify] === 3) does this spreadsheet have more than one tab, and is "Sheet1" really the first one? ===');
  const { sheets } = getSheetsClients();
  const response = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
  const sheetsList = response.data.sheets ?? [];
  console.log('[post-fix-verify]   total tabs in this spreadsheet:', sheetsList.length);
  sheetsList.forEach((s, i) => {
    const props = s.properties;
    console.log(
      `[post-fix-verify]     index=${i}  sheetId(gid)=${props?.sheetId}  title=${JSON.stringify(props?.title)}  ` +
        `is_what_our_unprefixed_ranges_target=${i === 0}`,
    );
  });
  const firstTabTitle = sheetsList[0]?.properties?.title;
  console.log(
    `[post-fix-verify]   our code's ranges (e.g. "A2:M", no sheet-name prefix) always target index 0 -- ` +
      `title="${firstTabTitle}". If this is not "Sheet1", a human checking the "Sheet1" tab is looking at a ` +
      `DIFFERENT tab than the one this pipeline reads/writes.`,
  );
}

async function main(): Promise<void> {
  const spreadsheetId = process.argv[2];
  if (!spreadsheetId) {
    console.error('[post-fix-verify] usage: tsx scripts/tmp-diagnostic-post-fix-verification.ts <spreadsheetId>');
    process.exitCode = 1;
    return;
  }

  const processStartTime = await checkProcessAndSourceHash();
  await checkSyncedAtVsProcessStart(processStartTime);
  await checkSpreadsheetTabs(spreadsheetId);

  console.log('[post-fix-verify] DONE -- read-only, nothing was created, modified, or deleted.');
}

main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : 'unknown error';
    console.error('[post-fix-verify] FAILED:', message.slice(0, 500));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
