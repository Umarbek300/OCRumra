/**
 * TEMPORARY ONE-OFF DIAGNOSTIC — not part of the production OCR pipeline.
 * Real, single-message end-to-end production validation:
 *   Telegram photo -> downloadTelegramPhoto -> selectProvider(env.OCR_PROVIDER)
 *   .extract() [Google Vision: MRZ + structural visual issue-date extraction]
 *   -> createPassportOcrResult (PostgreSQL).
 *
 * This calls the REAL, unmodified production performPassportOcr() with its
 * own REAL default dependencies (no mocks) -- the exact same function and
 * code path the live worker calls for a queued job. The difference is this
 * script never touches Redis or the worker loop at all: it is invoked
 * directly, once, for one message. The live worker process is therefore
 * never started, stopped, or restarted by this script.
 *
 * Safety, all structural (verified by reading the production code, not
 * assumed):
 *  - Idempotent: performPassportOcr() checks findExistingResult() first and
 *    returns immediately if a passport_ocr_results row already exists for
 *    this telegram_message -- this script goes further and never even
 *    attempts the OCR call in that case (see step 2 below).
 *  - createPassportOcrResult's INSERT uses
 *    ON CONFLICT (telegram_message_id) DO NOTHING -- a second row for the
 *    same message is structurally impossible at the DB layer.
 *  - No code path here (or anywhere in src/) writes to the `customers`
 *    table -- this pipeline cannot create a customer record.
 *  - No Tesseract: the real selectProvider(env.OCR_PROVIDER) is used
 *    unmodified, whatever the server's current .env says (google-vision).
 *
 * PII-safe: never logs raw OCR text, the full extraction object, or any
 * actual field value (name/date/passport number) -- only booleans, counts,
 * and confidence-level enum labels.
 *
 * Usage:
 *   tsx scripts/tmp-diagnostic-real-single-message-e2e.ts <telegram_message_id>
 *   tsx scripts/tmp-diagnostic-real-single-message-e2e.ts
 *     (no argument: read-only auto-discovers a real telegram_messages row
 *     that has group_id/agent_id set AND zero existing passport_ocr_results
 *     rows -- guaranteeing this run can never interfere with, overwrite, or
 *     even touch any already-processed message's existing result.)
 */
import { performPassportOcr } from '../src/worker/performPassportOcr.js';
import { findTelegramMessageById } from '../src/db/repositories/telegramMessages.repo.js';
import { findPassportOcrResultByTelegramMessageId, type PassportOcrResultRecord } from '../src/db/repositories/passportOcrResult.repo.js';
import { pool } from '../src/db/pool.js';

const FIELD_NAMES = [
  'firstName',
  'middleName',
  'surname',
  'passportNumber',
  'dateOfBirth',
  'passportIssueDate',
  'passportExpiryDate',
  'gender',
  'nationality',
  'placeOfBirth',
  'issuingAuthority',
  'mrz',
] as const satisfies readonly (keyof PassportOcrResultRecord)[];

/** PII-safe: present/confidence only, never the actual field value. */
function formatResultSummary(result: PassportOcrResultRecord): string {
  const lines = FIELD_NAMES.map((name) => {
    const entry = result[name] as { value: unknown; confidence: string | null };
    return `  ${name}: present=${entry.value !== null} confidence=${entry.confidence ?? 'null'}`;
  });
  return [
    `provider=${result.provider}`,
    `model=${result.model}`,
    `overallConfidence=${result.overallConfidence}`,
    'fields:',
    ...lines,
  ].join('\n');
}

/**
 * Read-only: finds a real telegram_messages row that (a) has group_id and
 * agent_id set (the same precondition the real worker enforces) and (b) has
 * NO existing passport_ocr_results row at all. A message picked this way
 * can never collide with, overwrite, or require touching any already-
 * processed message's existing result -- the LEFT JOIN ... IS NULL
 * condition is the guarantee, not a promise.
 */
async function findUnprocessedRealMessageId(): Promise<string | null> {
  const { rows } = await pool.query<{ telegram_message_id: string }>(
    `SELECT tm.telegram_message_id
       FROM telegram_messages tm
       LEFT JOIN passport_ocr_results r ON r.telegram_message_id = tm.id
      WHERE r.id IS NULL
        AND tm.group_id IS NOT NULL
        AND tm.agent_id IS NOT NULL
      ORDER BY tm.created_at DESC
      LIMIT 1`,
  );
  return rows[0]?.telegram_message_id ?? null;
}

async function main(): Promise<void> {
  let telegramMessageNum = process.argv[2];

  try {
    if (!telegramMessageNum) {
      console.log('[real-e2e] no telegram_message_id given -- auto-discovering an unprocessed real message (read-only)');
      const discovered = await findUnprocessedRealMessageId();
      if (!discovered) {
        console.log('[real-e2e] no unprocessed real message found (every eligible message already has a passport_ocr_results row); nothing to do');
        return;
      }
      telegramMessageNum = discovered;
      console.log(`[real-e2e] discovered unprocessed telegram_message_id=${telegramMessageNum}`);
    }

    console.log(`[real-e2e] ===== telegram_message_id=${telegramMessageNum} =====`);

    const lookup = await pool.query<{ id: string }>(
      `SELECT id FROM telegram_messages WHERE telegram_message_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [telegramMessageNum],
    );
    const row = lookup.rows[0];
    if (!row) {
      console.log('[real-e2e] no telegram_messages row found for this telegram_message_id');
      return;
    }

    const message = await findTelegramMessageById(row.id);
    if (!message) {
      console.log('[real-e2e] telegram_messages row disappeared between lookup and read (unexpected)');
      return;
    }
    if (!message.groupId || !message.agentId) {
      console.log('[real-e2e] message is missing group_id/agent_id -- same precondition the real worker enforces; aborting (no OCR call, no write)');
      return;
    }

    // Step 2: read-only precheck. If a result already exists, stop here --
    // never even attempt a real Vision/Telegram call for an already-processed
    // message (belt-and-suspenders on top of performPassportOcr's own check
    // and the DB's ON CONFLICT DO NOTHING).
    const existing = await findPassportOcrResultByTelegramMessageId(message.id);
    if (existing) {
      console.log('[real-e2e] alreadyExists=true -- a passport_ocr_results row already exists for this message. No OCR call made, no write attempted.');
      console.log(formatResultSummary(existing));
      return;
    }

    console.log('[real-e2e] alreadyExists=false -- proceeding with real performPassportOcr() (real Telegram download, real Vision call, real Postgres write)');

    // The REAL production function, REAL default dependencies -- no mocks.
    await performPassportOcr({
      telegramMessageId: message.id,
      telegramPhotoFileId: message.telegramPhotoFileId,
      groupId: message.groupId,
      agentId: message.agentId,
    });

    const stored = await findPassportOcrResultByTelegramMessageId(message.id);
    if (!stored) {
      console.log('[real-e2e] no passport_ocr_results row found after performPassportOcr() -- unexpected, investigate');
      return;
    }

    console.log('[real-e2e] write confirmed. Result summary (PII-safe -- presence + confidence only):');
    console.log(formatResultSummary(stored));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('[real-e2e] failed:', error instanceof Error ? error.message : 'unknown error');
  process.exitCode = 1;
});
