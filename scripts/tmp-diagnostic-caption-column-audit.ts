/**
 * TEMPORARY ONE-OFF DIAGNOSTIC — not part of the production OCR/Sheets
 * pipeline. Never imported by src/, never wired into any worker.
 *
 * Purpose: the previous caption-format audit found ZERO non-empty
 * caption_text rows among the most recent 30 telegram_messages. Before
 * concluding anything about parsePackageDeposit.ts's regexes, this checks
 * the more basic question: is caption_text actually being populated at all
 * in production, in what proportion, and does the column itself (per the
 * DB schema, not just application code) match what migrations/
 * 0013_add_telegram_message_caption.sql defines (telegram_messages.
 * caption_text TEXT NULL)?
 *
 * READ-ONLY: only SELECT statements (including one against information_
 * schema.columns, itself a read-only metadata view). No INSERT/UPDATE/
 * DELETE anywhere. No Sheets API, no Telegram Bot API, no OCR provider, no
 * service interaction of any kind.
 *
 * PRIVACY: caption text itself is never printed — only its NULL-ness and
 * character length. No passport/OCR field is touched at all here.
 */
import { pool } from '../src/db/pool.js';

interface CountRow {
  count: string;
}

interface RecentRow {
  id: string;
  created_at: Date | string;
  caption_is_null: boolean;
  caption_length: number | null;
}

interface ColumnRow {
  column_name: string;
  data_type: string;
  is_nullable: string;
}

async function main(): Promise<void> {
  console.log('[caption-column-audit] === 1) total telegram_messages row count ===');
  const { rows: totalRows } = await pool.query<CountRow>(`SELECT COUNT(*)::text AS count FROM telegram_messages`);
  console.log(`[caption-column-audit]   total rows: ${totalRows[0]?.count ?? '0'}`);

  console.log('[caption-column-audit] === 2) caption_text IS NOT NULL row count ===');
  const { rows: notNullRows } = await pool.query<CountRow>(
    `SELECT COUNT(*)::text AS count FROM telegram_messages WHERE caption_text IS NOT NULL`,
  );
  console.log(`[caption-column-audit]   caption_text IS NOT NULL: ${notNullRows[0]?.count ?? '0'}`);

  console.log("[caption-column-audit] === 3) caption_text IS NOT NULL AND trim(caption_text) <> '' row count ===");
  const { rows: nonEmptyRows } = await pool.query<CountRow>(
    `SELECT COUNT(*)::text AS count FROM telegram_messages WHERE caption_text IS NOT NULL AND trim(caption_text) <> ''`,
  );
  console.log(`[caption-column-audit]   non-empty after trim: ${nonEmptyRows[0]?.count ?? '0'}`);

  console.log('[caption-column-audit] === 4) most recent 10 telegram_messages rows (length/null only, never content) ===');
  const { rows: recentRows } = await pool.query<RecentRow>(
    `SELECT id, created_at, (caption_text IS NULL) AS caption_is_null, length(caption_text) AS caption_length
     FROM telegram_messages
     ORDER BY created_at DESC
     LIMIT 10`,
  );
  for (const r of recentRows) {
    console.log(
      `[caption-column-audit]   id=${r.id}  created_at=${r.created_at}  caption_is_null=${r.caption_is_null}  caption_length=${r.caption_length ?? '(null)'}`,
    );
  }

  console.log('[caption-column-audit] === 5) information_schema.columns check for telegram_messages.caption_text ===');
  const { rows: columnRows } = await pool.query<ColumnRow>(
    `SELECT column_name, data_type, is_nullable
     FROM information_schema.columns
     WHERE table_name = 'telegram_messages' AND column_name = 'caption_text'`,
  );
  if (columnRows.length === 0) {
    console.log('[caption-column-audit]   *** column telegram_messages.caption_text NOT FOUND in schema ***');
  } else {
    for (const c of columnRows) {
      console.log(`[caption-column-audit]   column_name=${c.column_name}  data_type=${c.data_type}  is_nullable=${c.is_nullable}`);
    }
  }

  console.log('[caption-column-audit] DONE -- read-only, nothing was created, modified, or deleted.');
}

main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : 'unknown error';
    console.error('[caption-column-audit] FAILED:', message.slice(0, 500));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
