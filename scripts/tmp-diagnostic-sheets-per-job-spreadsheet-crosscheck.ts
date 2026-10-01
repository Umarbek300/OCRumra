/**
 * TEMPORARY ONE-OFF DIAGNOSTIC — not part of the production OCR/Sheets
 * pipeline. Never imported by src/, never wired into any worker.
 *
 * Investigates the reported symptom: some 'synced' sheet_sync_queue jobs
 * appear to show empty/wrong J/K/L (Paket/Depozit/Qoldiq) and M (technical
 * id) columns when manually checked in Google Sheets.
 *
 * Does NOT assume a single hard-coded GROUP_ID or spreadsheet ID. Each
 * job's spreadsheet is resolved independently, through its own
 * queue job -> telegram_message_id -> telegram_messages.group_id -> group
 * -> group.google_sheet_id chain — exactly the same resolution
 * syncPassportRowToSheet.ts itself performs at write time (see
 * src/sheets/ensureGroupSheet.ts). If production has more than one group
 * (each with its own spreadsheet, by design), checking a job's row number
 * against the WRONG spreadsheet would look exactly like "columns are
 * blank" without any code being broken at all — this script surfaces that
 * possibility explicitly (see "spreadsheet mismatch" in the summary)
 * instead of assuming one sheet.
 *
 * Reads ONLY columns that exist in production's CURRENT schema (migrations
 * 0001-0012 -- i.e. it deliberately does NOT select telegram_messages.
 * caption_text or sheet_sync_queue.confirmation_sent_at, which only exist
 * in this sandbox's not-yet-deployed migrations 0013/0014). Uses raw SQL
 * throughout for this reason, never the repo modules' own SELECT_COLUMNS.
 *
 * READ-ONLY: only SELECTs from Postgres and spreadsheets.values.get from
 * Google Sheets. Never INSERTs/UPDATEs/DELETEs anything, never writes to
 * Google Sheets, never calls syncPassportRowToSheet() or upsertRowInSheet(),
 * never starts/restarts any worker or service, never touches
 * SHEETS_SYNC_ENABLED, never invokes any OCR provider (Tesseract or
 * otherwise -- this project uses Google Cloud Vision only).
 *
 * PRIVACY: columns that can carry passport-identifying data (B..H: Ism,
 * Familiya, Passport №, Tug'ilgan sana, Berilgan sana, Amal qilish sanasi,
 * Jins) and the Agent name (I) are MASKED (maskValue below -- first+last
 * character only, middle replaced with '*'; the full value is never
 * printed). Paket/Depozit/Qoldiq (J/K/L) are printed in full -- they are
 * prices, not passport data. № (A) and the technical id (M, a UUID) are
 * printed in full -- neither is PII.
 */
import { pool } from '../src/db/pool.js';
import { getSheetsClients } from '../src/sheets/sheetsAuth.js';
import { FIRST_DATA_ROW_NUMBER, TECHNICAL_ID_COLUMN_LETTER } from '../src/sheets/sheetLayout.js';

/** Shows shape/length without revealing content: "ERIKSSON" -> "E******N". Empty/undefined is reported as such, never masked-to-nothing silently. */
function maskValue(value: string | undefined): string {
  if (!value) return '(empty)';
  if (value.length <= 2) return '*'.repeat(value.length);
  return `${value[0]}${'*'.repeat(value.length - 2)}${value[value.length - 1]}`;
}

interface QueueRow {
  id: string;
  telegram_message_id: string;
  status: string;
  sheet_row_number: number | null;
}

interface TelegramMessageRow {
  id: string;
  group_id: string | null;
}

interface GroupRow {
  id: string;
  name: string;
  google_sheet_id: string | null;
}

interface JobCheckResult {
  jobId: string;
  groupId: string | null;
  spreadsheetId: string | null;
  recordedRow: number | null;
  actualRow: number | null;
  foundByM: boolean;
  rowNumberMatches: boolean | null;
  jklEmpty: boolean | null;
  pass: boolean;
  reason: string;
}

async function main(): Promise<void> {
  console.log('[crosscheck] === 1) all sheet_sync_queue jobs (existing columns only) ===');
  const { rows: allJobs } = await pool.query<QueueRow>(
    `SELECT id, telegram_message_id, status, sheet_row_number FROM sheet_sync_queue ORDER BY created_at`,
  );
  const syncedJobs = allJobs.filter((j) => j.status === 'synced');
  console.log('[crosscheck] total sheet_sync_queue jobs (any status):', allJobs.length);
  console.log('[crosscheck] synced jobs:', syncedJobs.length);
  if (syncedJobs.length === 0) {
    console.log('[crosscheck] no synced jobs -- nothing to cross-check. DONE.');
    return;
  }

  console.log('[crosscheck] === 2) resolve each synced job -> telegram_message -> group -> spreadsheet ===');
  const messageIds = syncedJobs.map((j) => j.telegram_message_id);
  const { rows: messages } = await pool.query<TelegramMessageRow>(
    `SELECT id, group_id FROM telegram_messages WHERE id = ANY($1::uuid[])`,
    [messageIds],
  );
  const messageById = new Map(messages.map((m) => [m.id, m]));

  const groupIds = [...new Set(messages.map((m) => m.group_id).filter((id): id is string => id !== null))];
  const { rows: groups } = await pool.query<GroupRow>(
    `SELECT id, name, google_sheet_id FROM groups WHERE id = ANY($1::uuid[])`,
    [groupIds],
  );
  const groupById = new Map(groups.map((g) => [g.id, g]));

  interface Resolved {
    job: QueueRow;
    groupId: string | null;
    spreadsheetId: string | null;
    problem: string | null;
  }
  const resolved: Resolved[] = syncedJobs.map((job) => {
    const message = messageById.get(job.telegram_message_id);
    if (!message) return { job, groupId: null, spreadsheetId: null, problem: 'telegram_message row not found (orphaned job)' };
    if (!message.group_id) return { job, groupId: null, spreadsheetId: null, problem: 'telegram_message.group_id is NULL' };
    const group = groupById.get(message.group_id);
    if (!group) return { job, groupId: message.group_id, spreadsheetId: null, problem: 'group row not found' };
    if (!group.google_sheet_id) return { job, groupId: message.group_id, spreadsheetId: null, problem: 'group has no google_sheet_id' };
    return { job, groupId: message.group_id, spreadsheetId: group.google_sheet_id, problem: null };
  });

  const distinctSpreadsheets = new Set(resolved.map((r) => r.spreadsheetId).filter((id): id is string => id !== null));
  console.log('[crosscheck] distinct groups involved:', new Set(resolved.map((r) => r.groupId).filter(Boolean)).size);
  console.log('[crosscheck] distinct spreadsheets involved:', distinctSpreadsheets.size, [...distinctSpreadsheets]);

  // "Spreadsheet mismatch": jobs whose resolved spreadsheet is NOT the most
  // common one among synced jobs. If a manual check only ever looked at
  // "the" (single, assumed) spreadsheet, every job in the minority would
  // have looked broken/missing there even though its own write was correct.
  const spreadsheetFrequency = new Map<string, number>();
  for (const id of distinctSpreadsheets) spreadsheetFrequency.set(id, 0);
  for (const r of resolved) if (r.spreadsheetId) spreadsheetFrequency.set(r.spreadsheetId, (spreadsheetFrequency.get(r.spreadsheetId) ?? 0) + 1);
  let majoritySpreadsheetId: string | null = null;
  let majorityCount = -1;
  for (const [id, count] of spreadsheetFrequency) {
    if (count > majorityCount) {
      majoritySpreadsheetId = id;
      majorityCount = count;
    }
  }

  console.log('[crosscheck] === 3) per-spreadsheet bulk read (A2:M) ===');
  const { sheets } = getSheetsClients();
  const rowsBySpreadsheet = new Map<string, string[][]>();
  for (const spreadsheetId of distinctSpreadsheets) {
    const range = `A${FIRST_DATA_ROW_NUMBER}:${TECHNICAL_ID_COLUMN_LETTER}`;
    const response = await sheets.spreadsheets.values.get({ spreadsheetId, range });
    const values = (response.data.values ?? []) as string[][];
    rowsBySpreadsheet.set(spreadsheetId, values);
    console.log(`[crosscheck]   spreadsheet ${spreadsheetId}: ${values.length} data rows read`);
  }

  console.log('[crosscheck] === 4) per-job PASS/FAIL cross-check against its OWN resolved spreadsheet ===');
  const results: JobCheckResult[] = [];

  for (const r of resolved) {
    if (r.problem !== null || !r.spreadsheetId) {
      const reason = r.problem ?? 'unknown resolution problem';
      results.push({
        jobId: r.job.id,
        groupId: r.groupId,
        spreadsheetId: r.spreadsheetId,
        recordedRow: r.job.sheet_row_number,
        actualRow: null,
        foundByM: false,
        rowNumberMatches: null,
        jklEmpty: null,
        pass: false,
        reason,
      });
      console.log(`[crosscheck]   job=${r.job.id}  group_id=${r.groupId ?? '(null)'}  FAIL  reason=${reason}`);
      continue;
    }

    const sheetRows = rowsBySpreadsheet.get(r.spreadsheetId) ?? [];
    const idx = sheetRows.findIndex((row) => row[12] === r.job.telegram_message_id);

    if (idx === -1) {
      const reason = 'NOT FOUND by column M in its own resolved spreadsheet';
      results.push({
        jobId: r.job.id,
        groupId: r.groupId,
        spreadsheetId: r.spreadsheetId,
        recordedRow: r.job.sheet_row_number,
        actualRow: null,
        foundByM: false,
        rowNumberMatches: null,
        jklEmpty: null,
        pass: false,
        reason,
      });
      console.log(
        `[crosscheck]   job=${r.job.id}  group_id=${r.groupId}  spreadsheet=${r.spreadsheetId}  FAIL  reason=${reason}  ` +
          `(recorded sheet_row_number=${r.job.sheet_row_number ?? '(null)'})`,
      );
      continue;
    }

    const row = sheetRows[idx]!;
    const actualRowNumber = idx + FIRST_DATA_ROW_NUMBER;
    const rowNumberMatches = actualRowNumber === r.job.sheet_row_number;
    const paket = row[9] ?? '';
    const depozit = row[10] ?? '';
    const qoldiq = row[11] ?? '';
    const jklEmpty = paket.length === 0 && depozit.length === 0 && qoldiq.length === 0;
    const mMatches = row[12] === r.job.telegram_message_id;

    // PASS criteria right now: found by M, row number recorded in the DB
    // matches the row actually found, and M itself matches the job's own
    // telegram_message_id. J/K/L being empty is NOT a failure condition —
    // package/deposit/balance parsing is not yet deployed to production
    // (see the summary note below), so empty is the currently-expected
    // state, not a defect this script should flag as FAIL.
    const pass = mMatches && rowNumberMatches;

    results.push({
      jobId: r.job.id,
      groupId: r.groupId,
      spreadsheetId: r.spreadsheetId,
      recordedRow: r.job.sheet_row_number,
      actualRow: actualRowNumber,
      foundByM: true,
      rowNumberMatches,
      jklEmpty,
      pass,
      reason: pass ? 'ok' : !mMatches ? 'M column value does not match job telegram_message_id' : 'sheet_row_number mismatch',
    });

    console.log(
      `[crosscheck]   job=${r.job.id}  group_id=${r.groupId}  spreadsheet=${r.spreadsheetId}  ` +
        `${pass ? 'PASS' : 'FAIL'}  recorded_row=${r.job.sheet_row_number}  actual_row=${actualRowNumber}  row_number_matches=${rowNumberMatches}\n` +
      `[crosscheck]     A(№)=${row[0] ?? '(empty)'}  ` +
        `B(Ism)=${maskValue(row[1])}  C(Familiya)=${maskValue(row[2])}  D(Passport№)=${maskValue(row[3])}  ` +
        `E(TugSana)=${maskValue(row[4])}  F(BerilganSana)=${maskValue(row[5])}  G(AmalQilish)=${maskValue(row[6])}  ` +
        `H(Jins)=${maskValue(row[7])}  I(Agent)=${maskValue(row[8])}\n` +
      `[crosscheck]     J(Paket)=${paket || '(empty)'}  K(Depozit)=${depozit || '(empty)'}  L(Qoldiq)=${qoldiq || '(empty)'}  ` +
        `M(technical_id)=${row[12] ?? '(empty)'}  M_matches_job=${mMatches}`,
    );
  }

  console.log('[crosscheck] === 5) summary ===');
  const rowMismatchCount = results.filter((r) => r.rowNumberMatches === false).length;
  const mMismatchCount = results.filter((r) => !r.foundByM).length;
  const jklMismatchCount = results.filter((r) => r.jklEmpty === false).length; // unexpectedly non-empty right now
  const jklEmptyCount = results.filter((r) => r.jklEmpty === true).length;
  const spreadsheetMismatchCount = results.filter((r) => r.spreadsheetId !== null && r.spreadsheetId !== majoritySpreadsheetId).length;
  const passCount = results.filter((r) => r.pass).length;
  const failCount = results.length - passCount;

  console.log('[crosscheck]   total jobs (any status):', allJobs.length);
  console.log('[crosscheck]   synced jobs checked:', syncedJobs.length);
  console.log('[crosscheck]   PASS:', passCount, '  FAIL:', failCount);
  console.log('[crosscheck]   row mismatch (recorded sheet_row_number != actual row found):', rowMismatchCount);
  console.log('[crosscheck]   M mismatch (not found by column M in its own resolved spreadsheet):', mMismatchCount);
  console.log('[crosscheck]   J/K/L mismatch (unexpectedly non-empty right now):', jklMismatchCount, '  (all-empty, currently expected:', jklEmptyCount, ')');
  console.log(
    '[crosscheck]   spreadsheet mismatch (job\'s own spreadsheet differs from the majority spreadsheet among synced jobs):',
    spreadsheetMismatchCount,
    majoritySpreadsheetId ? `(majority spreadsheet: ${majoritySpreadsheetId}, ${majorityCount} jobs)` : '',
  );
  console.log(
    '[crosscheck]   NOTE: package/deposit/balance parsing + caption_text plumbing is NOT yet deployed to production ' +
      '(still an undeployed patch) -- Paket/Depozit/Qoldiq being empty for every synced job is therefore EXPECTED right now, not a bug.',
  );

  console.log('[crosscheck] DONE -- read-only, nothing was created, modified, or deleted.');
}

main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : 'unknown error';
    console.error('[crosscheck] FAILED:', message.slice(0, 500));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
