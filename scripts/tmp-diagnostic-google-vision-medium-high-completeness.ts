/**
 * TEMPORARY ONE-OFF DIAGNOSTIC — not part of the production OCR/Sheets
 * pipeline. Never imported by src/, never wired into any worker.
 *
 * READ-ONLY follow-up to tmp-diagnostic-find-high-confidence-google-vision-ocr.ts,
 * which found 6 google-vision records in this group but 0 at
 * overall_confidence='high'. This script:
 *   1) breaks down those 6 records by overall_confidence (high/medium/low
 *      counts only -- a confidence level is metadata, not passport data),
 *   2) for the medium+high subset, checks NULL/NOT_NULL for the 7 core
 *      fields per record (never their values),
 *   3) counts how many of those have ALL 7 fields non-null,
 *   4) if any fully-complete record exists, prints ONLY its internal
 *      ocr_result_id and telegram_message_id (UUIDs) -- never any
 *      passport value or MRZ text.
 *
 * Never INSERTs/UPDATEs/DELETEs anything, never touches Google
 * Sheets/Drive/Apps Script, never enqueues a sheet_sync_queue job, never
 * starts the worker, never invokes any OCR provider (Tesseract or
 * otherwise) -- this only reads pre-existing passport_ocr_results rows.
 */
import { pool } from '../src/db/pool.js';

const GROUP_ID = 'c7e35e47-cb80-4816-abaf-2c96b57fe0d2';

interface FieldRow {
  ocr_result_id: string;
  telegram_message_id: string;
  overall_confidence: string;
  has_first_name: boolean;
  has_surname: boolean;
  has_passport_number: boolean;
  has_date_of_birth: boolean;
  has_passport_issue_date: boolean;
  has_passport_expiry_date: boolean;
  has_gender: boolean;
}

async function main(): Promise<void> {
  console.log('[gv-medium-high-completeness] group_id:', GROUP_ID);

  console.log('[gv-medium-high-completeness] === 1) overall_confidence breakdown for the 6 google-vision records ===');
  const { rows: confidenceRows } = await pool.query<{ overall_confidence: string; count: string }>(
    `SELECT por.overall_confidence, COUNT(*) AS count
     FROM passport_ocr_results por
     JOIN telegram_messages tm ON tm.id = por.telegram_message_id
     WHERE tm.group_id = $1 AND por.provider = 'google-vision'
     GROUP BY por.overall_confidence
     ORDER BY por.overall_confidence`,
    [GROUP_ID],
  );
  for (const row of confidenceRows) {
    console.log(`[gv-medium-high-completeness]   overall_confidence=${row.overall_confidence}: count=${row.count}`);
  }

  console.log('[gv-medium-high-completeness] === 2) per-record field completeness within medium+high confidence ===');
  const { rows: fieldRows } = await pool.query<FieldRow>(
    `SELECT
       por.id AS ocr_result_id,
       tm.id AS telegram_message_id,
       por.overall_confidence,
       (por.first_name IS NOT NULL) AS has_first_name,
       (por.surname IS NOT NULL) AS has_surname,
       (por.passport_number IS NOT NULL) AS has_passport_number,
       (por.date_of_birth IS NOT NULL) AS has_date_of_birth,
       (por.passport_issue_date IS NOT NULL) AS has_passport_issue_date,
       (por.passport_expiry_date IS NOT NULL) AS has_passport_expiry_date,
       (por.gender IS NOT NULL) AS has_gender
     FROM passport_ocr_results por
     JOIN telegram_messages tm ON tm.id = por.telegram_message_id
     WHERE tm.group_id = $1
       AND por.provider = 'google-vision'
       AND por.overall_confidence IN ('high', 'medium')
     ORDER BY por.overall_confidence, tm.created_at DESC`,
    [GROUP_ID],
  );

  if (fieldRows.length === 0) {
    console.log('[gv-medium-high-completeness]   no records at overall_confidence high or medium in this group.');
  }

  const fullyComplete: FieldRow[] = [];
  for (const row of fieldRows) {
    const allSevenPresent =
      row.has_first_name &&
      row.has_surname &&
      row.has_passport_number &&
      row.has_date_of_birth &&
      row.has_passport_issue_date &&
      row.has_passport_expiry_date &&
      row.has_gender;
    if (allSevenPresent) fullyComplete.push(row);

    console.log(
      `[gv-medium-high-completeness]   ocr_result_id=${row.ocr_result_id}  confidence=${row.overall_confidence} ` +
        `first_name=${row.has_first_name} surname=${row.has_surname} passport_number=${row.has_passport_number} ` +
        `date_of_birth=${row.has_date_of_birth} issue_date=${row.has_passport_issue_date} ` +
        `expiry_date=${row.has_passport_expiry_date} gender=${row.has_gender} ALL_SEVEN_PRESENT=${allSevenPresent}`,
    );
  }

  console.log('[gv-medium-high-completeness] === 3) summary ===');
  console.log(
    `[gv-medium-high-completeness]   ${fullyComplete.length} of ${fieldRows.length} medium/high google-vision ` +
      'records have all 7 core fields non-null.',
  );

  if (fullyComplete.length > 0) {
    const chosen = fullyComplete[0]!;
    console.log('[gv-medium-high-completeness] === 4) chosen candidate (internal ids only, never passport values) ===');
    console.log('[gv-medium-high-completeness]   ocr_result_id:', chosen.ocr_result_id);
    console.log('[gv-medium-high-completeness]   telegram_message_id:', chosen.telegram_message_id);
    console.log('[gv-medium-high-completeness]   overall_confidence:', chosen.overall_confidence);
    console.log('[gv-medium-high-completeness]   NOT sent to Sheets yet -- awaiting review before any sync step.');
  }

  console.log('[gv-medium-high-completeness] DONE -- read-only, nothing was created, modified, or deleted.');
}

main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : 'unknown error';
    console.error('[gv-medium-high-completeness] FAILED:', message.slice(0, 300));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
