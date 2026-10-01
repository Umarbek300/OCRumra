/**
 * TEMPORARY ONE-OFF DIAGNOSTIC — not part of the production OCR/Sheets
 * pipeline. Never imported by src/, never wired into any worker.
 *
 * READ-ONLY: a single SELECT against passport_ocr_results for one
 * hard-coded ocr_result_id, to check whether the mostly-empty Sheets row
 * observed for this record (only "Agent" populated, everything else
 * empty) originates from this OCR record itself being mostly NULL, or
 * from a Sheets-pipeline bug.
 *
 * Never INSERTs/UPDATEs/DELETEs anything, never touches Google
 * Sheets/Drive/Apps Script, never starts the worker, never touches any
 * other table.
 *
 * PRIVACY: never selects or prints the actual value of any passport field
 * (first_name, middle_name, surname, passport_number, dates, gender,
 * nationality, place_of_birth, issuing_authority, mrz) — only whether each
 * is NULL or NOT_NULL. overall_confidence/provider/model are metadata
 * (confidence level, OCR provider name), not passport content, so those
 * are printed in full.
 */
import { pool } from '../src/db/pool.js';

const OCR_RESULT_ID = 'e3ce06e2-1d88-4763-ac53-d49e3550ddfb';

const CONTENT_FIELDS = [
  'first_name',
  'middle_name',
  'surname',
  'passport_number',
  'date_of_birth',
  'passport_issue_date',
  'passport_expiry_date',
  'gender',
  'nationality',
  'place_of_birth',
  'issuing_authority',
  'mrz',
] as const;

async function main(): Promise<void> {
  const { rows } = await pool.query<Record<string, unknown>>(
    `SELECT * FROM passport_ocr_results WHERE id = $1`,
    [OCR_RESULT_ID],
  );
  const row = rows[0];
  if (!row) {
    console.log(`[ocr-null-check] no passport_ocr_results row found with id=${OCR_RESULT_ID}`);
    return;
  }

  console.log('[ocr-null-check] ocr_result_id:', OCR_RESULT_ID);
  console.log('[ocr-null-check] === per-field NULL / NOT_NULL status (values never printed) ===');
  for (const field of CONTENT_FIELDS) {
    const status = row[field] === null || row[field] === undefined ? 'NULL' : 'NOT_NULL';
    console.log(`[ocr-null-check]   ${field}: ${status}`);
  }

  console.log('[ocr-null-check] === metadata (not passport content -- safe to show in full) ===');
  console.log('[ocr-null-check]   overall_confidence:', row.overall_confidence ?? '(null)');
  console.log('[ocr-null-check]   provider:', row.provider ?? '(null)');
  console.log('[ocr-null-check]   model:', row.model ?? '(null)');

  console.log('[ocr-null-check] DONE -- read-only, nothing was created, modified, or deleted.');
}

main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : 'unknown error';
    console.error('[ocr-null-check] FAILED:', message.slice(0, 300));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
