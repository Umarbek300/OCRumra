/**
 * TEMPORARY ONE-OFF DIAGNOSTIC — not part of the production OCR/Sheets
 * pipeline. Never imported by src/, never wired into any worker.
 *
 * READ-ONLY: SELECTs only. Finds one passport_ocr_results row, within the
 * one test group, that was produced by Google Cloud Vision (provider =
 * 'google-vision' -- confirmed against src/ocr/providers/googleVisionProvider.ts's
 * own `name: 'google-vision'`), has overall_confidence = 'high', and has
 * the core fields (first_name, surname, passport_number, date_of_birth,
 * passport_issue_date, passport_expiry_date, gender) all non-null.
 *
 * Never INSERTs/UPDATEs/DELETEs anything, never touches Google
 * Sheets/Drive/Apps Script, never enqueues a sheet_sync_queue job, never
 * starts the worker.
 *
 * PRIVACY: never selects or prints the actual value of any passport field
 * or the MRZ text -- only booleans (field present or not) and metadata
 * (confidence level, provider name), plus internal UUIDs.
 */
import { pool } from '../src/db/pool.js';

const GROUP_ID = 'c7e35e47-cb80-4816-abaf-2c96b57fe0d2';

async function main(): Promise<void> {
  console.log('[find-high-confidence-ocr] group_id:', GROUP_ID);

  const { rows: candidateRows } = await pool.query<{
    ocr_result_id: string;
    telegram_message_id: string;
    overall_confidence: string;
    provider: string;
  }>(
    `SELECT por.id AS ocr_result_id, tm.id AS telegram_message_id, por.overall_confidence, por.provider
     FROM passport_ocr_results por
     JOIN telegram_messages tm ON tm.id = por.telegram_message_id
     WHERE tm.group_id = $1
       AND por.provider = 'google-vision'
       AND por.overall_confidence = 'high'
       AND por.first_name IS NOT NULL
       AND por.surname IS NOT NULL
       AND por.passport_number IS NOT NULL
       AND por.date_of_birth IS NOT NULL
       AND por.passport_issue_date IS NOT NULL
       AND por.passport_expiry_date IS NOT NULL
       AND por.gender IS NOT NULL
     ORDER BY tm.created_at DESC
     LIMIT 1`,
    [GROUP_ID],
  );

  const candidate = candidateRows[0];
  if (candidate) {
    console.log('[find-high-confidence-ocr] === MATCH FOUND ===');
    console.log('[find-high-confidence-ocr] ocr_result_id:', candidate.ocr_result_id);
    console.log('[find-high-confidence-ocr] telegram_message_id:', candidate.telegram_message_id);
    console.log('[find-high-confidence-ocr] provider:', candidate.provider);
    console.log('[find-high-confidence-ocr] overall_confidence:', candidate.overall_confidence);
    console.log('[find-high-confidence-ocr] has_first_name: true');
    console.log('[find-high-confidence-ocr] has_surname: true');
    console.log('[find-high-confidence-ocr] has_passport_number: true');
    console.log('[find-high-confidence-ocr] has_date_of_birth: true');
    console.log('[find-high-confidence-ocr] has_passport_issue_date: true');
    console.log('[find-high-confidence-ocr] has_passport_expiry_date: true');
    console.log('[find-high-confidence-ocr] has_gender: true');
    console.log('[find-high-confidence-ocr] group match: true (this group only)');
    console.log('[find-high-confidence-ocr] DONE -- read-only, nothing was created, modified, or deleted.');
    return;
  }

  console.log('[find-high-confidence-ocr] === NO MATCH -- breaking down why ===');

  const { rows: totalRows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*) FROM passport_ocr_results por
     JOIN telegram_messages tm ON tm.id = por.telegram_message_id
     WHERE tm.group_id = $1`,
    [GROUP_ID],
  );
  console.log('[find-high-confidence-ocr] total OCR results in this group:', totalRows[0]?.count ?? '0');

  const { rows: providerRows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*) FROM passport_ocr_results por
     JOIN telegram_messages tm ON tm.id = por.telegram_message_id
     WHERE tm.group_id = $1 AND por.provider = 'google-vision'`,
    [GROUP_ID],
  );
  console.log('[find-high-confidence-ocr] ...of which provider = google-vision:', providerRows[0]?.count ?? '0');

  const { rows: confidenceRows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*) FROM passport_ocr_results por
     JOIN telegram_messages tm ON tm.id = por.telegram_message_id
     WHERE tm.group_id = $1 AND por.provider = 'google-vision' AND por.overall_confidence = 'high'`,
    [GROUP_ID],
  );
  console.log(
    '[find-high-confidence-ocr] ...of which also overall_confidence = high:',
    confidenceRows[0]?.count ?? '0',
  );

  const { rows: fieldRows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*) FROM passport_ocr_results por
     JOIN telegram_messages tm ON tm.id = por.telegram_message_id
     WHERE tm.group_id = $1
       AND por.provider = 'google-vision'
       AND por.overall_confidence = 'high'
       AND por.first_name IS NOT NULL
       AND por.surname IS NOT NULL
       AND por.passport_number IS NOT NULL
       AND por.date_of_birth IS NOT NULL
       AND por.passport_issue_date IS NOT NULL
       AND por.passport_expiry_date IS NOT NULL
       AND por.gender IS NOT NULL`,
    [GROUP_ID],
  );
  console.log(
    '[find-high-confidence-ocr] ...of which also all 6 core fields are non-null:',
    fieldRows[0]?.count ?? '0',
  );

  console.log(
    '[find-high-confidence-ocr] Read the counts above top-to-bottom: the first one that drops to 0 is the ' +
      'condition that eliminated every candidate in this group.',
  );
  console.log('[find-high-confidence-ocr] DONE -- read-only, nothing was created, modified, or deleted.');
}

main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : 'unknown error';
    console.error('[find-high-confidence-ocr] FAILED:', message.slice(0, 300));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
