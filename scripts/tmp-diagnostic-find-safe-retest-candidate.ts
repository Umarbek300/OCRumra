/**
 * TEMPORARY ONE-OFF DIAGNOSTIC — not part of the production OCR/Sheets
 * pipeline. Never imported by src/, never wired into any worker.
 *
 * Purpose: find a SAFE way to test the deterministic upsertRowInSheet.ts
 * fix against a real production job, without touching any of the 15
 * existing 'synced' rows and without inventing synthetic data.
 *
 * The production pipeline already auto-enqueues a sheet_sync_queue row for
 * every OCR'd, fully-linked (group+agent) telegram_message via
 * performPassportOcr.ts's enqueueSheetSyncSafely (see that file's own doc
 * comment: "safety-nets any older passport_ocr_results row that predates
 * this queue" -- calling enqueueSheetSync again for a message that already
 * has a queue row is a guaranteed no-op, since sheet_sync_queue.
 * telegram_message_id is UNIQUE with ON CONFLICT DO NOTHING).
 *
 * This script looks for a REAL, already-existing, fully-linked passport
 * that either:
 *   (a) has no sheet_sync_queue row at all yet, or
 *   (b) has one stuck in 'pending' or 'failed' (never reached 'synced'),
 * which would let the sheets-sync worker (already running the fixed code)
 * process it completely naturally on its own next poll -- no new code
 * path, no manual Sheets write, no restart.
 *
 * If no such candidate exists, the only remaining safe option is a
 * genuinely new real Telegram passport, which this script will state
 * explicitly.
 *
 * READ-ONLY: only SELECTs from Postgres. Never INSERTs/UPDATEs/DELETEs
 * anything, never calls enqueueSheetSync or any Sheets API, never starts
 * or restarts any service, never invokes any OCR provider (Tesseract or
 * otherwise -- this project uses Google Cloud Vision only).
 *
 * PRIVACY: only ids, timestamps, group name, and queue status are
 * printed. No passport field is ever logged.
 */
import { pool } from '../src/db/pool.js';

interface CandidateRow {
  telegram_message_id: string;
  group_id: string;
  group_name: string;
  agent_id: string;
  ocr_result_id: string;
  ocr_created_at: string;
  queue_id: string | null;
  queue_status: string | null;
}

async function main(): Promise<void> {
  console.log('[find-retest-candidate] === looking for a fully-linked, OCR-complete passport with no synced queue row ===');

  const { rows } = await pool.query<CandidateRow>(
    `SELECT
       tm.id AS telegram_message_id,
       tm.group_id,
       g.name AS group_name,
       tm.agent_id,
       por.id AS ocr_result_id,
       por.created_at AS ocr_created_at,
       ssq.id AS queue_id,
       ssq.status AS queue_status
     FROM telegram_messages tm
     JOIN passport_ocr_results por ON por.telegram_message_id = tm.id
     JOIN groups g ON g.id = tm.group_id
     LEFT JOIN sheet_sync_queue ssq ON ssq.telegram_message_id = tm.id
     WHERE tm.group_id IS NOT NULL
       AND tm.agent_id IS NOT NULL
       AND (ssq.id IS NULL OR ssq.status IN ('pending', 'failed'))
     ORDER BY por.created_at DESC`,
  );

  console.log('[find-retest-candidate] candidates found:', rows.length);
  for (const r of rows) {
    console.log(
      `[find-retest-candidate]   telegram_message_id=${r.telegram_message_id}  group="${r.group_name}"  ` +
        `ocr_result_id=${r.ocr_result_id}  ocr_created_at=${r.ocr_created_at}  ` +
        `existing_queue_id=${r.queue_id ?? '(none)'}  existing_queue_status=${r.queue_status ?? '(none)'}`,
    );
  }

  if (rows.length === 0) {
    console.log(
      '[find-retest-candidate]   NO SAFE EXISTING CANDIDATE FOUND. Every fully-linked, OCR-complete passport already ' +
        'has a queue row in a terminal state other than pending/failed (i.e. already synced). The only remaining ' +
        'safe way to test the fix against a real job is a genuinely NEW real Telegram passport.',
    );
  } else {
    console.log(
      '[find-retest-candidate]   At least one safe candidate exists above. For the FIRST one listed (most recent), ' +
        'the safe next step is calling enqueueSheetSync(telegram_message_id) once -- idempotent, ON CONFLICT DO ' +
        'NOTHING, cannot disturb any existing row -- then letting the already-running sheets-sync worker process it ' +
        'on its own next poll.',
    );
  }

  console.log('[find-retest-candidate] === for reference: current sheet_sync_queue status counts ===');
  const { rows: statusCounts } = await pool.query<{ status: string; count: string }>(
    `SELECT status, COUNT(*)::text AS count FROM sheet_sync_queue GROUP BY status`,
  );
  for (const s of statusCounts) {
    console.log(`[find-retest-candidate]   ${s.status}: ${s.count}`);
  }

  console.log('[find-retest-candidate] DONE -- read-only, nothing was created, modified, or deleted.');
}

main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : 'unknown error';
    console.error('[find-retest-candidate] FAILED:', message.slice(0, 500));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
