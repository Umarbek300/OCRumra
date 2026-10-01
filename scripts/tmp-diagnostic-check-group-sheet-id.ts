/**
 * TEMPORARY ONE-OFF DIAGNOSTIC — not part of the production OCR/Sheets
 * pipeline. Never imported by src/, never wired into any worker.
 *
 * READ-ONLY: a single SELECT against the groups table for one hard-coded
 * group id, to check whether ensureGroupSheet.ts's new Apps Script
 * provisioning path actually reached setGroupGoogleSheetId() for it.
 * Never INSERTs/UPDATEs/DELETEs anything, never touches any other table.
 *
 * Uses the EXISTING, unmodified src/db/pool.ts (same connectionString the
 * whole app already uses via env.DATABASE_URL) — never reads or prints
 * DATABASE_URL or any other credential itself; only ever prints the two
 * selected, non-secret columns (a UUID and a Drive file id, both already
 * known/shared elsewhere in this work).
 */
import { pool } from '../src/db/pool.js';

const GROUP_ID = 'c7e35e47-cb80-4816-abaf-2c96b57fe0d2';

async function main(): Promise<void> {
  const { rows } = await pool.query<{ id: string; google_sheet_id: string | null }>(
    'SELECT id, google_sheet_id FROM groups WHERE id = $1',
    [GROUP_ID],
  );
  const row = rows[0];
  if (!row) {
    console.log(`[check-group-sheet-id] no group found with id=${GROUP_ID}`);
    return;
  }
  console.log('[check-group-sheet-id] id:', row.id);
  console.log('[check-group-sheet-id] google_sheet_id:', row.google_sheet_id ?? '(null — not yet set)');
}

main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : 'unknown error';
    console.error('[check-group-sheet-id] FAILED:', message.slice(0, 300));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
