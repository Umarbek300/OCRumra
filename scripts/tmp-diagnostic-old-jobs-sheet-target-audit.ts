/**
 * TEMPORARY ONE-OFF DIAGNOSTIC — not part of the production OCR/Sheets
 * pipeline. Never imported by src/, never wired into any worker.
 *
 * Purpose: closes the remaining evidence gap in the row 2/3/4 collision
 * investigation. Confirmed so far (from tmp-diagnostic-row2-3-4-forensic-
 * timeline.ts + production's upsertRowInSheet.ts source + its 07:54:30-40
 * UTC journal logs): all three NEW jobs (6014ea93, 88fd503d, 267650c1) that
 * synced at 07:54:34/35/36 UTC on 2026-09-28 logged action="appended" for
 * spreadsheet 16oTz3UkPqYIlyiqk3Gv-4CA9Le1uIw0DSeO7ItecPWs -- meaning
 * upsertRowInSheet's own A2:M read found 0, then 1, then 2 existing rows at
 * the moments those three calls ran, NOT 1, 2, 3 pre-existing rows from the
 * three OLDER jobs (3c1133fb, fba10826, 8c77e99f) that the DB says already
 * synced to rows 2/3/4 back on 2026-09-26/27. This script checks the one
 * remaining explanation that distinguishes "the sheet was reset/changed"
 * from "the physical sheet was edited/cleared": did those three OLDER jobs
 * write to the SAME spreadsheet id, or a different one?
 *
 * Checks, both read-only:
 *   1. DB: for all 6 target queue jobs, their group_id, group_name, and the
 *      group's CURRENT google_sheet_id on record (to see whether all 6
 *      belong to the same group, and what spreadsheet that group is
 *      currently configured to use).
 *   2. journalctl: the ocrumra-sheets-sync.service log lines from the exact
 *      moments the three OLDER jobs originally synced (each job's own
 *      synced_at, +/-10s buffer), to read the "sheet=<id>" they actually
 *      wrote to at that time -- directly comparable against
 *      16oTz3UkPqYIlyiqk3Gv-4CA9Le1uIw0DSeO7ItecPWs (the id the three NEWER
 *      jobs used, already visible in this conversation's own pasted output,
 *      so repeating it here in a diagnostic is not a new exposure).
 *
 * READ-ONLY: only SELECT against Postgres, and journalctl reads via a
 * read-only systemd query (no -f follow, no service interaction). No
 * INSERT/UPDATE/DELETE, no Sheets API call, no service restart/reload, no
 * queue retry, no Tesseract/local OCR.
 */
import { execSync } from 'node:child_process';
import { pool } from '../src/db/pool.js';

const ALL_SIX_QUEUE_IDS = [
  '3c1133fb-bcfd-401a-97c7-925c1410b630',
  '6014ea93-8c37-41d8-91b8-88f0395ad3f5',
  'fba10826-7357-43e1-982e-4d320d3a9208',
  '88fd503d-fa3a-4052-a25a-16dab52d2f0d',
  '8c77e99f-e0ca-4871-be0d-73b30c84a1f4',
  '267650c1-a68b-4009-bf7b-9e21ef1a8f76',
];

const OLDER_JOBS_TIME_WINDOWS: { queueId: string; since: string; until: string }[] = [
  { queueId: '3c1133fb-bcfd-401a-97c7-925c1410b630', since: '2026-09-26 19:23:06 UTC', until: '2026-09-26 19:23:26 UTC' },
  { queueId: 'fba10826-7357-43e1-982e-4d320d3a9208', since: '2026-09-27 04:36:11 UTC', until: '2026-09-27 04:36:31 UTC' },
  { queueId: '8c77e99f-e0ca-4871-be0d-73b30c84a1f4', since: '2026-09-27 17:10:23 UTC', until: '2026-09-27 17:10:43 UTC' },
];

interface GroupSheetRow {
  queue_id: string;
  telegram_message_id: string;
  group_id: string;
  group_name: string;
  google_sheet_id: string | null;
}

async function checkGroupSheetIds(): Promise<void> {
  console.log('[old-jobs-sheet-target-audit] === step 1: group + CURRENT google_sheet_id for all 6 target jobs ===');
  const { rows } = await pool.query<GroupSheetRow>(
    `SELECT
       ssq.id AS queue_id,
       ssq.telegram_message_id,
       tm.group_id,
       g.name AS group_name,
       g.google_sheet_id
     FROM sheet_sync_queue ssq
     JOIN telegram_messages tm ON tm.id = ssq.telegram_message_id
     JOIN groups g ON g.id = tm.group_id
     WHERE ssq.id = ANY($1::uuid[])
     ORDER BY ssq.id`,
    [ALL_SIX_QUEUE_IDS],
  );

  for (const r of rows) {
    console.log(
      `[old-jobs-sheet-target-audit]   queue_id=${r.queue_id}  telegram_message_id=${r.telegram_message_id}  ` +
        `group_id=${r.group_id}  group_name=${JSON.stringify(r.group_name)}  current_google_sheet_id=${r.google_sheet_id ?? '(none)'}`,
    );
  }

  const distinctGroupIds = new Set(rows.map((r) => r.group_id));
  const distinctSheetIds = new Set(rows.map((r) => r.google_sheet_id ?? '(none)'));
  console.log(`[old-jobs-sheet-target-audit]   distinct group_id count among all 6 jobs: ${distinctGroupIds.size}`);
  console.log(`[old-jobs-sheet-target-audit]   distinct CURRENT google_sheet_id count among all 6 jobs: ${distinctSheetIds.size}`);
}

function checkOlderJobJournalLogs(): void {
  console.log('[old-jobs-sheet-target-audit] === step 2: journal logs from when the 3 OLDER jobs originally synced ===');
  for (const window of OLDER_JOBS_TIME_WINDOWS) {
    console.log(`[old-jobs-sheet-target-audit]   --- queue_id=${window.queueId}  window=[${window.since} .. ${window.until}] ---`);
    try {
      const output = execSync(
        `journalctl -u ocrumra-sheets-sync.service --utc --since "${window.since}" --until "${window.until}" --no-pager`,
        { encoding: 'utf8' },
      );
      const trimmed = output.trim();
      console.log(trimmed.length > 0 ? trimmed : '[old-jobs-sheet-target-audit]     (no log lines in this window)');
    } catch (error) {
      console.log(
        `[old-jobs-sheet-target-audit]     journalctl query failed: ${error instanceof Error ? error.message.slice(0, 300) : 'unknown error'}`,
      );
    }
  }
}

async function main(): Promise<void> {
  await checkGroupSheetIds();
  checkOlderJobJournalLogs();
  console.log('[old-jobs-sheet-target-audit] DONE -- read-only, nothing was created, modified, or deleted.');
}

main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : 'unknown error';
    console.error('[old-jobs-sheet-target-audit] FAILED:', message.slice(0, 500));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
