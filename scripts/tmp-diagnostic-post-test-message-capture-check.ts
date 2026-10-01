/**
 * TEMPORARY ONE-OFF DIAGNOSTIC — not part of the production OCR/Sheets
 * pipeline. Never imported by src/, never wired into any worker.
 *
 * Purpose: after a human operator sends one or more NEW real test messages
 * (photo/document with a caption, and optionally a standalone text message)
 * to the actual production Telegram group, this reads back the newest
 * telegram_messages rows to see exactly what the bot actually captured --
 * since bot.ts's caption/media_group_id mapping into these columns was
 * already proven, by direct code inspection, to be a lossless, unmodified
 * copy of ctx.message.caption / ctx.message.media_group_id. Reading these
 * columns for a brand-new row is therefore equivalent to inspecting the
 * real Telegram message metadata, without needing any code change, raw-
 * payload logging, or Bot API history call (which does not exist for bots
 * in the first place).
 *
 * Run this AFTER sending the test message(s), not before -- it only shows
 * whatever already exists in telegram_messages at the moment it runs.
 *
 * READ-ONLY: only SELECT statements against telegram_messages. No
 * INSERT/UPDATE/DELETE anywhere in this file. No Sheets API, no Telegram
 * Bot API call of any kind, no OCR provider, no service interaction.
 *
 * PRIVACY: caption text itself is never printed -- only its NULL-ness and
 * character length. No passport/OCR field is touched at all here.
 */
import { pool } from '../src/db/pool.js';

const RECENT_LIMIT = 5;

interface RecentRow {
  id: string;
  source: string;
  created_at: Date | string;
  caption_is_null: boolean;
  caption_length: number | null;
  media_group_id_is_null: boolean;
  group_id_is_null: boolean;
  agent_id_is_null: boolean;
}

async function main(): Promise<void> {
  console.log('[post-test-capture-check] === most recent telegram_messages rows (run this AFTER sending your test message) ===');

  const { rows } = await pool.query<RecentRow>(
    `SELECT
       id,
       source,
       created_at,
       (caption_text IS NULL) AS caption_is_null,
       length(caption_text) AS caption_length,
       (media_group_id IS NULL) AS media_group_id_is_null,
       (group_id IS NULL) AS group_id_is_null,
       (agent_id IS NULL) AS agent_id_is_null
     FROM telegram_messages
     ORDER BY created_at DESC
     LIMIT $1`,
    [RECENT_LIMIT],
  );

  console.log(`[post-test-capture-check]   most recent ${RECENT_LIMIT} rows:`);
  for (const r of rows) {
    console.log(
      `[post-test-capture-check]     id=${r.id}  source=${r.source}  created_at=${r.created_at}  ` +
        `caption_is_null=${r.caption_is_null}  caption_length=${r.caption_length ?? '(null)'}  ` +
        `media_group_id_is_null=${r.media_group_id_is_null}  group_id_is_null=${r.group_id_is_null}  agent_id_is_null=${r.agent_id_is_null}`,
    );
  }

  console.log(
    '[post-test-capture-check]   NOTE: source is always "photo" or "document" -- there is no third value, because ' +
      'no message:text handler exists in bot.ts. A standalone text message sent as a separate, non-caption message ' +
      'can NEVER appear as a row here at all (not even a row with an empty caption) -- this table only ever gets a ' +
      'row when message:photo or message:document actually fires.',
  );

  console.log('[post-test-capture-check] DONE -- read-only, nothing was created, modified, or deleted.');
}

main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : 'unknown error';
    console.error('[post-test-capture-check] FAILED:', message.slice(0, 500));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
