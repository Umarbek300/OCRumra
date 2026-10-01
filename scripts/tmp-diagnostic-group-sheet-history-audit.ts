/**
 * TEMPORARY ONE-OFF DIAGNOSTIC — not part of the production OCR/Sheets
 * pipeline. Never imported by src/, never wired into any worker.
 *
 * Purpose: answers items 5, 6, 7 of the google_sheet_id storage/history
 * audit -- the only parts of that audit that source code alone cannot
 * settle. Source-code audit (done separately, no execution needed)
 * established:
 *   - groups.google_sheet_id is a plain nullable TEXT column (migrations/
 *     0002_create_groups.sql), no separate history/audit/version table
 *     exists anywhere in migrations/.
 *   - The ONLY write path is setGroupGoogleSheetId (groups.repo.ts).
 *     Its UPDATE has "WHERE id = $1 AND google_sheet_id IS NULL" -- it can
 *     ONLY set the column while still NULL, and can NEVER overwrite an
 *     already-set value. No other UPDATE touches this column anywhere.
 *   - groups rows are only ever created by the manual admin CLI
 *     (src/admin/registerGroup.ts), keyed by telegram_chat_id UNIQUE with
 *     ON CONFLICT (telegram_chat_id) DO UPDATE SET name=.., departure_date=..
 *     -- deliberately never touching google_sheet_id, so re-running that
 *     command for an existing chat_id is safe. But it IS possible for an
 *     operator to register a SECOND groups row (new UUID, google_sheet_id
 *     starts NULL) with the same human-readable name but a DIFFERENT
 *     telegram_chat_id -- the DB schema has no UNIQUE constraint on name.
 *   - No code path anywhere reassigns telegram_messages.group_id after
 *     insert.
 *
 * This script checks, read-only, whether the DB's actual data is
 * consistent with a SINGLE groups row (ruling that explanation in/out) by:
 *   1. listing every groups row whose name matches "20 September 2026",
 *      with its own created_at/updated_at (the only proxy for "history"
 *      this schema has -- updated_at moves only on an UPDATE to that row).
 *   2. for the 6 forensic sheet_sync_queue jobs, their actual group_id
 *      (via telegram_messages) and which of the groups rows above each one
 *      points to.
 *
 * READ-ONLY: only SELECT statements. No INSERT/UPDATE/DELETE anywhere in
 * this file. No Sheets API call. No service interaction. No Tesseract.
 *
 * PRIVACY: only ids, names (group names are trip labels, not passport
 * PII), timestamps, and the google_sheet_id itself (a Sheets document id,
 * already visible multiple times in this conversation's own pasted
 * output -- not passport/OCR content) are printed.
 */
import { pool } from '../src/db/pool.js';

const GROUP_NAME_MATCH = '20 September 2026';

const FORENSIC_QUEUE_IDS = [
  '3c1133fb-bcfd-401a-97c7-925c1410b630',
  '6014ea93-8c37-41d8-91b8-88f0395ad3f5',
  'fba10826-7357-43e1-982e-4d320d3a9208',
  '88fd503d-fa3a-4052-a25a-16dab52d2f0d',
  '8c77e99f-e0ca-4871-be0d-73b30c84a1f4',
  '267650c1-a68b-4009-bf7b-9e21ef1a8f76',
];

interface GroupRow {
  id: string;
  name: string;
  departure_date: string;
  telegram_chat_id: string | null;
  google_sheet_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

async function reportMatchingGroups(): Promise<void> {
  console.log(`[group-sheet-history-audit] === step 1: every groups row whose name matches "${GROUP_NAME_MATCH}" ===`);
  const { rows } = await pool.query<GroupRow>(
    `SELECT id, name, departure_date, telegram_chat_id, google_sheet_id, created_at, updated_at
     FROM groups
     WHERE name ILIKE $1
     ORDER BY created_at`,
    [`%${GROUP_NAME_MATCH}%`],
  );

  console.log(`[group-sheet-history-audit]   matching groups rows found: ${rows.length}`);
  for (const g of rows) {
    console.log(
      `[group-sheet-history-audit]   group_id=${g.id}  name=${JSON.stringify(g.name)}  departure_date=${g.departure_date}  ` +
        `telegram_chat_id=${g.telegram_chat_id ?? '(none)'}  google_sheet_id=${g.google_sheet_id ?? '(none)'}  ` +
        `created_at=${g.created_at}  updated_at=${g.updated_at}  ` +
        `updated_since_created=${new Date(g.updated_at).getTime() !== new Date(g.created_at).getTime()}`,
    );
  }

  if (rows.length > 1) {
    const distinctSheetIds = new Set(rows.map((g) => g.google_sheet_id ?? '(none)'));
    console.log(
      `[group-sheet-history-audit]   *** MULTIPLE groups rows share this name (${rows.length}) *** -- ` +
        `distinct google_sheet_id values among them: ${distinctSheetIds.size}`,
    );
  } else if (rows.length === 1) {
    console.log('[group-sheet-history-audit]   exactly ONE groups row has this name.');
  } else {
    console.log('[group-sheet-history-audit]   NO groups row matches this name at all.');
  }
}

interface JobGroupRow {
  queue_id: string;
  telegram_message_id: string;
  synced_at: Date | string | null;
  group_id: string;
  group_created_at: Date | string;
  group_updated_at: Date | string;
  group_google_sheet_id: string | null;
}

async function reportForensicJobsGroupLinkage(): Promise<void> {
  console.log('[group-sheet-history-audit] === step 2: which groups row does each of the 6 forensic jobs actually point to? ===');
  const { rows } = await pool.query<JobGroupRow>(
    `SELECT
       ssq.id AS queue_id,
       ssq.telegram_message_id,
       ssq.synced_at,
       g.id AS group_id,
       g.created_at AS group_created_at,
       g.updated_at AS group_updated_at,
       g.google_sheet_id AS group_google_sheet_id
     FROM sheet_sync_queue ssq
     JOIN telegram_messages tm ON tm.id = ssq.telegram_message_id
     JOIN groups g ON g.id = tm.group_id
     WHERE ssq.id = ANY($1::uuid[])
     ORDER BY ssq.synced_at`,
    [FORENSIC_QUEUE_IDS],
  );

  for (const r of rows) {
    console.log(
      `[group-sheet-history-audit]   queue_id=${r.queue_id}  synced_at=${r.synced_at ?? '(none)'}  group_id=${r.group_id}  ` +
        `group_created_at=${r.group_created_at}  group_updated_at=${r.group_updated_at}  google_sheet_id=${r.group_google_sheet_id ?? '(none)'}`,
    );
  }

  const distinctGroupIds = new Set(rows.map((r) => r.group_id));
  const distinctSheetIds = new Set(rows.map((r) => r.group_google_sheet_id ?? '(none)'));
  console.log(`[group-sheet-history-audit]   distinct group_id among the 6 forensic jobs: ${distinctGroupIds.size}`);
  console.log(`[group-sheet-history-audit]   distinct google_sheet_id among the 6 forensic jobs: ${distinctSheetIds.size}`);
  if (distinctGroupIds.size > 1) {
    console.log(
      '[group-sheet-history-audit]   *** the 6 forensic jobs do NOT all point to the same groups row -- this alone ' +
        'would fully explain independent row numbering (two different groups = two different spreadsheets, each ' +
        'with its own row 2/3/4). ***',
    );
  } else if (distinctGroupIds.size === 1) {
    console.log(
      '[group-sheet-history-audit]   all 6 forensic jobs point to the SAME single groups row -- rules out ' +
        '"different group_id" as the explanation; the google_sheet_id on that one row is whatever every one of ' +
        "these jobs' upsertRowInSheet call actually used.",
    );
  }
}

async function main(): Promise<void> {
  await reportMatchingGroups();
  await reportForensicJobsGroupLinkage();
  console.log('[group-sheet-history-audit] DONE -- read-only, nothing was created, modified, or deleted.');
}

main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : 'unknown error';
    console.error('[group-sheet-history-audit] FAILED:', message.slice(0, 500));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
