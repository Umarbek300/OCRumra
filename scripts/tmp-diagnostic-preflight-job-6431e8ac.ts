/**
 * TEMPORARY ONE-OFF DIAGNOSTIC — not part of the production OCR/Sheets
 * pipeline. Never imported by src/, never wired into any worker.
 *
 * READ-ONLY combined preflight for the third (last remaining) of the 3
 * known stale 'failed' sheet_sync_queue jobs -- job_id=6431e8ac-ac32-4c00-
 * 8628-abd5fe0a6614 (telegram_message_id=4d1a8bec-8afe-41ad-9952-
 * 7b12d50b5ece) -- run after the other 2 (8c77e99f-..., 37c616ad-...) were
 * already retried successfully in this session.
 *
 * Combines, in one script, the same checks already used individually
 * earlier in this session:
 *   1) job status/attempts/sheet_row_number/last_error (DB SELECT)
 *   2) group.google_sheet_id (DB SELECT)
 *   3) sheet data row count + № sequence intact (Sheets values.get, read-only)
 *   4) column M (technical id) uniqueness across all current rows
 *   5) whether this job's own telegram_message_id is already present in
 *      column M (duplicate-risk signal)
 *   6) passport_ocr_results completeness for the 7 core fields (DB SELECT,
 *      NULL/NOT_NULL only, never values)
 *   7) last_error safe category classification (raw text never printed)
 *
 * Never INSERTs/UPDATEs/DELETEs anything, never writes to Google Sheets,
 * never calls syncPassportRowToSheet(), never starts/restarts any worker or
 * service, never reads or changes SHEETS_SYNC_ENABLED, never invokes any
 * OCR provider.
 *
 * PRIVACY: no passport field value, no last_error raw text, no agent name
 * -- only booleans, counts, enum/status values, ids, and safe error
 * category labels.
 */
import { pool } from '../src/db/pool.js';
import { getSheetsClients } from '../src/sheets/sheetsAuth.js';
import { FIRST_DATA_ROW_NUMBER, TECHNICAL_ID_COLUMN_LETTER } from '../src/sheets/sheetLayout.js';

const GROUP_ID = 'c7e35e47-cb80-4816-abaf-2c96b57fe0d2';
const JOB_ID = '6431e8ac-ac32-4c00-8628-abd5fe0a6614';
const TELEGRAM_MESSAGE_ID = '4d1a8bec-8afe-41ad-9952-7b12d50b5ece';

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
  console.log('[preflight-6431e8ac] === 1) job status/attempts/sheet_row_number/telegram_message_id/last_error ===');
  const { rows: jobRows } = await pool.query<{
    telegram_message_id: string;
    status: string;
    attempts: number;
    sheet_row_number: number | null;
    last_error: string | null;
  }>(`SELECT telegram_message_id, status, attempts, sheet_row_number, last_error FROM sheet_sync_queue WHERE id = $1`, [JOB_ID]);
  const job = jobRows[0];
  if (!job) {
    console.log('[preflight-6431e8ac] job not found -- stopping.');
    return;
  }
  console.log('[preflight-6431e8ac]   telegram_message_id:', job.telegram_message_id);
  console.log('[preflight-6431e8ac]   telegram_message_id matches expected:', job.telegram_message_id === TELEGRAM_MESSAGE_ID);
  console.log('[preflight-6431e8ac]   status:', job.status);
  console.log('[preflight-6431e8ac]   attempts:', job.attempts);
  console.log('[preflight-6431e8ac]   sheet_row_number:', job.sheet_row_number ?? '(null)');
  console.log('[preflight-6431e8ac]   status is still "failed":', job.status === 'failed');

  console.log('[preflight-6431e8ac] === 2) group.google_sheet_id ===');
  const { rows: groupRows } = await pool.query<{ google_sheet_id: string | null }>(
    `SELECT google_sheet_id FROM groups WHERE id = $1`,
    [GROUP_ID],
  );
  const spreadsheetId = groupRows[0]?.google_sheet_id ?? null;
  console.log('[preflight-6431e8ac]   google_sheet_id present:', spreadsheetId !== null);
  if (!spreadsheetId) {
    console.log('[preflight-6431e8ac] cannot continue sheet-side checks without a spreadsheetId -- stopping.');
    return;
  }
  console.log('[preflight-6431e8ac]   spreadsheetId:', spreadsheetId);

  console.log('[preflight-6431e8ac] === 3/4/5) sheet data rows: count, № sequence, column M uniqueness + duplicate check ===');
  const { sheets } = getSheetsClients();
  const range = `A${FIRST_DATA_ROW_NUMBER}:${TECHNICAL_ID_COLUMN_LETTER}`;
  const response = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const rawRows = response.data.values ?? [];
  const numberValues = rawRows.map((raw) => (typeof raw[0] === 'string' && raw[0].length > 0 ? Number(raw[0]) : null));
  const technicalIds = rawRows.map((raw) => (typeof raw[12] === 'string' && raw[12].length > 0 ? raw[12] : null)).filter((id): id is string => id !== null);
  const sequenceOk = numberValues.every((value, index) => value === index + 1);
  const uniqueOk = new Set(technicalIds).size === technicalIds.length;
  const alreadyInSheet = technicalIds.includes(TELEGRAM_MESSAGE_ID);

  console.log('[preflight-6431e8ac]   total data rows:', rawRows.length);
  console.log('[preflight-6431e8ac]   № sequence intact (1..N):', sequenceOk, `values=[${numberValues.join(', ')}]`);
  console.log('[preflight-6431e8ac]   column M all unique:', uniqueOk, `(${technicalIds.length} non-empty, ${new Set(technicalIds).size} unique)`);
  console.log('[preflight-6431e8ac]   this job\'s telegram_message_id already present in column M:', alreadyInSheet);
  console.log('[preflight-6431e8ac]   duplicate-risk assessment: retry would', alreadyInSheet ? 'UPDATE the existing row (no new row)' : 'APPEND a brand-new row (no existing row to collide with)');

  console.log('[preflight-6431e8ac] === 6) passport_ocr_results completeness (NULL/NOT_NULL only) ===');
  const { rows: ocrRows } = await pool.query<{
    provider: string;
    overall_confidence: string;
    has_first_name: boolean;
    has_surname: boolean;
    has_passport_number: boolean;
    has_date_of_birth: boolean;
    has_passport_issue_date: boolean;
    has_passport_expiry_date: boolean;
    has_gender: boolean;
  }>(
    `SELECT
       provider,
       overall_confidence,
       (first_name IS NOT NULL) AS has_first_name,
       (surname IS NOT NULL) AS has_surname,
       (passport_number IS NOT NULL) AS has_passport_number,
       (date_of_birth IS NOT NULL) AS has_date_of_birth,
       (passport_issue_date IS NOT NULL) AS has_passport_issue_date,
       (passport_expiry_date IS NOT NULL) AS has_passport_expiry_date,
       (gender IS NOT NULL) AS has_gender
     FROM passport_ocr_results
     WHERE telegram_message_id = $1`,
    [TELEGRAM_MESSAGE_ID],
  );
  const ocr = ocrRows[0];
  if (!ocr) {
    console.log('[preflight-6431e8ac]   no passport_ocr_results row found (unexpected).');
  } else {
    console.log('[preflight-6431e8ac]   provider:', ocr.provider);
    console.log('[preflight-6431e8ac]   overall_confidence:', ocr.overall_confidence);
    const fields: Array<[string, boolean]> = [
      ['first_name', ocr.has_first_name],
      ['surname', ocr.has_surname],
      ['passport_number', ocr.has_passport_number],
      ['date_of_birth', ocr.has_date_of_birth],
      ['passport_issue_date', ocr.has_passport_issue_date],
      ['passport_expiry_date', ocr.has_passport_expiry_date],
      ['gender', ocr.has_gender],
    ];
    for (const [name, present] of fields) {
      console.log(`[preflight-6431e8ac]     ${name}: ${present ? 'present' : 'EMPTY'}`);
    }
    const presentCount = fields.filter(([, present]) => present).length;
    console.log(`[preflight-6431e8ac]   ${presentCount} of ${fields.length} core fields present.`);
  }

  console.log('[preflight-6431e8ac] === 7) last_error category ===');
  console.log('[preflight-6431e8ac]   category:', classifyError(job.last_error));

  console.log('[preflight-6431e8ac] DONE -- read-only, nothing was created, modified, or deleted.');
}

main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : 'unknown error';
    console.error('[preflight-6431e8ac] FAILED:', message.slice(0, 300));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
