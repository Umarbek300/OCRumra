/**
 * TEMPORARY ONE-OFF DIAGNOSTIC — not part of the production OCR/Sheets
 * pipeline. Never imported by src/, never wired into any worker.
 *
 * READ-ONLY audit of the E2E sync just performed for
 * telegram_message_id=92d36381-8450-40f4-a5ef-a8c79b1335e9 /
 * job_id=fba10826-7357-43e1-982e-4d320d3a9208, expected at sheet row 3 of
 * spreadsheet 16oTz3UkPqYIlyiqk3Gv-4CA9Le1uIw0DSeO7ItecPWs.
 *
 * Two READ-ONLY checks, no writes to either system:
 *   1) spreadsheets.values.get on A3:M3 -- reports column A (row number,
 *      not PII) and column M (technical id, a UUID, not PII) in full, and
 *      for columns B..L only whether the cell is populated plus a coarse
 *      type/format hint (never the actual passport value).
 *   2) a single SELECT of the sheet_sync_queue row by its hard-coded
 *      job_id -- status, attempts, sheet_row_number only.
 *
 * Never INSERTs/UPDATEs/DELETEs anything, never writes to Google Sheets,
 * never starts the worker, never invokes any OCR provider (Tesseract or
 * otherwise).
 *
 * PRIVACY: never prints the actual passport-derived value of any column
 * except A (row position) and M (a telegram_message_id UUID) -- for
 * columns B..L this only prints populated=true/false and a coarse format
 * hint (e.g. "looks like a date", "numeric", "text"), never the content.
 */
import { pool } from '../src/db/pool.js';
import { getSheetsClients } from '../src/sheets/sheetsAuth.js';
import { fullRowRange, TECHNICAL_ID_HEADER, VISIBLE_COLUMN_HEADERS } from '../src/sheets/sheetLayout.js';

const SPREADSHEET_ID = '16oTz3UkPqYIlyiqk3Gv-4CA9Le1uIw0DSeO7ItecPWs';
const EXPECTED_ROW = 3;
const EXPECTED_TELEGRAM_MESSAGE_ID = '92d36381-8450-40f4-a5ef-a8c79b1335e9';
const JOB_ID = 'fba10826-7357-43e1-982e-4d320d3a9208';

const ALL_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M'] as const;
const ALL_LABELS: readonly string[] = [...VISIBLE_COLUMN_HEADERS, TECHNICAL_ID_HEADER];

function coarseFormatHint(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value) || /^\d{2}[./-]\d{2}[./-]\d{2,4}$/.test(value)) return 'looks like a date';
  if (/^\d+$/.test(value)) return 'numeric';
  if (/^[A-Za-z0-9]+$/.test(value)) return 'alphanumeric';
  return 'text';
}

async function auditSheetRow(): Promise<void> {
  console.log('[row3-e2e-audit] === 1) Google Sheets A3:M3 (read-only) ===');
  const { sheets } = getSheetsClients();
  const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: fullRowRange(EXPECTED_ROW) });
  const row = response.data.values?.[0] ?? [];

  console.log('[row3-e2e-audit] spreadsheetId:', SPREADSHEET_ID);
  console.log('[row3-e2e-audit] row length (expected 13):', row.length);

  let columnAOk = false;
  let columnMOk = false;

  for (let i = 0; i < ALL_LETTERS.length; i++) {
    const letter = ALL_LETTERS[i]!;
    const label = ALL_LABELS[i]!;
    const value = row[i];

    if (letter === 'A') {
      const numericValue = typeof value === 'string' ? Number(value) : value;
      columnAOk = numericValue === EXPECTED_ROW;
      console.log(`[row3-e2e-audit] ${letter} (${label}): value=${value ?? '(empty)'}  equals_expected_row(${EXPECTED_ROW})=${columnAOk}`);
    } else if (letter === 'M') {
      columnMOk = value === EXPECTED_TELEGRAM_MESSAGE_ID;
      console.log(
        `[row3-e2e-audit] ${letter} (${label}): value=${value ?? '(empty)'}  matches_expected_telegram_message_id=${columnMOk}`,
      );
    } else {
      const populated = typeof value === 'string' && value.length > 0;
      const hint = populated ? coarseFormatHint(value) : 'n/a';
      console.log(`[row3-e2e-audit] ${letter} (${label}): populated=${populated}  format_hint=${hint}`);
    }
  }

  console.log('[row3-e2e-audit] === sheet-side checks ===');
  console.log('[row3-e2e-audit]   A3 == 3:', columnAOk);
  console.log('[row3-e2e-audit]   M3 == expected telegram_message_id:', columnMOk);
}

async function auditQueueJob(): Promise<void> {
  console.log('[row3-e2e-audit] === 2) sheet_sync_queue job status (read-only) ===');
  const { rows } = await pool.query<{
    id: string;
    telegram_message_id: string;
    status: string;
    attempts: number;
    sheet_row_number: number | null;
  }>(
    `SELECT id, telegram_message_id, status, attempts, sheet_row_number
     FROM sheet_sync_queue
     WHERE id = $1`,
    [JOB_ID],
  );
  const job = rows[0];
  if (!job) {
    console.log(`[row3-e2e-audit]   no sheet_sync_queue row found with id=${JOB_ID} (unexpected).`);
    return;
  }
  console.log('[row3-e2e-audit]   job_id:', job.id);
  console.log('[row3-e2e-audit]   telegram_message_id matches expected:', job.telegram_message_id === EXPECTED_TELEGRAM_MESSAGE_ID);
  console.log('[row3-e2e-audit]   status:', job.status);
  console.log('[row3-e2e-audit]   attempts:', job.attempts);
  console.log('[row3-e2e-audit]   sheet_row_number:', job.sheet_row_number);
  console.log('[row3-e2e-audit]   sheet_row_number == expected row(3):', job.sheet_row_number === EXPECTED_ROW);
}

async function main(): Promise<void> {
  await auditSheetRow();
  await auditQueueJob();
  console.log('[row3-e2e-audit] DONE -- read-only, nothing was created, modified, or deleted.');
}

main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : 'unknown error';
    console.error('[row3-e2e-audit] FAILED:', message.slice(0, 300));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
