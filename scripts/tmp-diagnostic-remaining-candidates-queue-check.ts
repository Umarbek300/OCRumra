/**
 * TEMPORARY ONE-OFF DIAGNOSTIC — not part of the production OCR/Sheets
 * pipeline. Never imported by src/, never wired into any worker.
 *
 * READ-ONLY: checks the remaining 2 fully-complete, medium-confidence
 * google-vision OCR candidates (from tmp-diagnostic-google-vision-medium-high-completeness.ts)
 * to find which one, if any, has NEVER had a sheet_sync_queue job created
 * for it -- i.e. a genuinely untested candidate, as opposed to
 * c1e13e5b-5db9-49e7-919f-6947c82a0f06, which already carries an old
 * 'failed' job (37c616ad-...) from earlier debugging before Apps Script
 * existed.
 *
 * Never INSERTs/UPDATEs/DELETEs anything, never touches Google
 * Sheets/Drive/Apps Script, never starts the worker, never invokes any
 * OCR provider (Tesseract or otherwise) -- this only reads pre-existing
 * rows.
 *
 * PRIVACY: never selects or prints any passport field value or MRZ text --
 * only booleans, ids, and sheet_sync_queue status/attempts.
 */
import { pool } from '../src/db/pool.js';

const OCR_RESULT_IDS = ['198d521a-1e49-4142-a1f7-025f3df93621', '88b3e185-93f0-4fca-bf8d-da1a59658541'];

interface CandidateRow {
  ocr_result_id: string;
  telegram_message_id: string;
  provider: string;
  overall_confidence: string;
  has_first_name: boolean;
  has_surname: boolean;
  has_passport_number: boolean;
  has_date_of_birth: boolean;
  has_passport_issue_date: boolean;
  has_passport_expiry_date: boolean;
  has_gender: boolean;
  queue_job_id: string | null;
  queue_status: string | null;
  queue_attempts: number | null;
}

async function main(): Promise<void> {
  const { rows } = await pool.query<CandidateRow>(
    `SELECT
       por.id AS ocr_result_id,
       tm.id AS telegram_message_id,
       por.provider,
       por.overall_confidence,
       (por.first_name IS NOT NULL) AS has_first_name,
       (por.surname IS NOT NULL) AS has_surname,
       (por.passport_number IS NOT NULL) AS has_passport_number,
       (por.date_of_birth IS NOT NULL) AS has_date_of_birth,
       (por.passport_issue_date IS NOT NULL) AS has_passport_issue_date,
       (por.passport_expiry_date IS NOT NULL) AS has_passport_expiry_date,
       (por.gender IS NOT NULL) AS has_gender,
       ssq.id AS queue_job_id,
       ssq.status AS queue_status,
       ssq.attempts AS queue_attempts
     FROM passport_ocr_results por
     JOIN telegram_messages tm ON tm.id = por.telegram_message_id
     LEFT JOIN sheet_sync_queue ssq ON ssq.telegram_message_id = tm.id
     WHERE por.id = ANY($1::uuid[])`,
    [OCR_RESULT_IDS],
  );

  console.log('[remaining-candidates] === per-candidate detail ===');
  const cleanCandidates: CandidateRow[] = [];
  const busyCandidates: CandidateRow[] = [];

  for (const ocrResultId of OCR_RESULT_IDS) {
    const row = rows.find((r) => r.ocr_result_id === ocrResultId);
    if (!row) {
      console.log(`[remaining-candidates] ocr_result_id=${ocrResultId}: NOT FOUND (unexpected)`);
      continue;
    }
    console.log(`[remaining-candidates] ocr_result_id=${row.ocr_result_id}`);
    console.log(`[remaining-candidates]   telegram_message_id: ${row.telegram_message_id}`);
    console.log(`[remaining-candidates]   provider: ${row.provider}`);
    console.log(`[remaining-candidates]   overall_confidence: ${row.overall_confidence}`);
    console.log(
      `[remaining-candidates]   fields: first_name=${row.has_first_name} surname=${row.has_surname} ` +
        `passport_number=${row.has_passport_number} date_of_birth=${row.has_date_of_birth} ` +
        `issue_date=${row.has_passport_issue_date} expiry_date=${row.has_passport_expiry_date} gender=${row.has_gender}`,
    );
    if (row.queue_job_id) {
      console.log(`[remaining-candidates]   sheet_sync_queue: EXISTING job_id=${row.queue_job_id} status=${row.queue_status} attempts=${row.queue_attempts}`);
      busyCandidates.push(row);
    } else {
      console.log('[remaining-candidates]   sheet_sync_queue: no job exists yet (clean)');
      cleanCandidates.push(row);
    }
  }

  console.log('[remaining-candidates] === CONCLUSION ===');
  if (cleanCandidates.length === 0) {
    console.log('[remaining-candidates] 1) neither remaining candidate is free of a queue job.');
  } else {
    for (const row of cleanCandidates) {
      console.log(`[remaining-candidates] 1) NO queue job: ocr_result_id=${row.ocr_result_id} telegram_message_id=${row.telegram_message_id}`);
    }
  }
  if (busyCandidates.length === 0) {
    console.log('[remaining-candidates] 2) neither remaining candidate has an existing job.');
  } else {
    for (const row of busyCandidates) {
      console.log(
        `[remaining-candidates] 2) HAS existing job: ocr_result_id=${row.ocr_result_id} job_id=${row.queue_job_id} status=${row.queue_status}`,
      );
    }
  }
  if (cleanCandidates.length > 0) {
    const chosen = cleanCandidates[0]!;
    console.log('[remaining-candidates] 3) clean candidate to use next:');
    console.log(`[remaining-candidates]    ocr_result_id: ${chosen.ocr_result_id}`);
    console.log(`[remaining-candidates]    telegram_message_id: ${chosen.telegram_message_id}`);
  } else {
    console.log('[remaining-candidates] 3) no clean candidate found among these two.');
  }
  console.log('[remaining-candidates] 4) no Sheet sync was performed -- read-only diagnostic only.');

  console.log('[remaining-candidates] DONE -- read-only, nothing was created, modified, or deleted.');
}

main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : 'unknown error';
    console.error('[remaining-candidates] FAILED:', message.slice(0, 300));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
