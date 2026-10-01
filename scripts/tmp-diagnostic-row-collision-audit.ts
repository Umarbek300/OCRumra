/**
 * TEMPORARY ONE-OFF DIAGNOSTIC — not part of the production OCR/Sheets
 * pipeline. Never imported by src/, never wired into any worker.
 *
 * Purpose: audit a reported row-number collision among 'synced'
 * sheet_sync_queue jobs whose sheet_row_number is 2, 3, or 4 — i.e. more
 * than one DB job possibly claiming the same physical Sheet row. This is
 * pure fact-gathering: it reports what the DB says vs. what the Sheet
 * physically contains right now, and leaves any causal conclusion to be
 * drawn afterward from the printed evidence — it does not itself assert a
 * root cause.
 *
 * READ-ONLY, end to end:
 *   - Postgres: only SELECT statements (sheet_sync_queue, telegram_messages,
 *     groups). No INSERT/UPDATE/DELETE anywhere in this file.
 *   - Google Sheets: only spreadsheets.values.get (read) against M2:M4 for
 *     each distinct spreadsheet these jobs reference. Never values.update,
 *     never values.append, never any provisioning call.
 *   - No service is started/stopped/restarted. No queue status is written.
 *     No Tesseract/local OCR is invoked.
 *
 * PRIVACY: prints ids, statuses, timestamps, attempts, group names (already
 * printed by earlier diagnostics this session, e.g. tmp-diagnostic-find-
 * safe-retest-candidate.ts — not passport/OCR content), and the technical
 * column M values (telegram_message_id UUIDs — the pipeline's own join key,
 * never passport/OCR content). The actual google_sheet_id string is never
 * printed, only whether it is present and a short internal label ("sheetA",
 * "sheetB", ...) so distinct spreadsheets can be told apart in this output
 * without exposing the real id.
 */
import { pool } from '../src/db/pool.js';
import { getSheetsClients } from '../src/sheets/sheetsAuth.js';

const TARGET_ROW_NUMBERS = [2, 3, 4];

interface CollisionCandidateRow {
  queue_id: string;
  telegram_message_id: string;
  status: string;
  sheet_row_number: number;
  synced_at: string | null;
  attempts: number;
  group_id: string;
  group_name: string;
  google_sheet_id: string | null;
}

async function fetchCandidates(): Promise<CollisionCandidateRow[]> {
  const { rows } = await pool.query<CollisionCandidateRow>(
    `SELECT
       ssq.id AS queue_id,
       ssq.telegram_message_id,
       ssq.status,
       ssq.sheet_row_number,
       ssq.synced_at,
       ssq.attempts,
       tm.group_id,
       g.name AS group_name,
       g.google_sheet_id
     FROM sheet_sync_queue ssq
     JOIN telegram_messages tm ON tm.id = ssq.telegram_message_id
     JOIN groups g ON g.id = tm.group_id
     WHERE ssq.status = 'synced' AND ssq.sheet_row_number = ANY($1::int[])
     ORDER BY g.google_sheet_id, ssq.sheet_row_number, ssq.synced_at`,
    [TARGET_ROW_NUMBERS],
  );
  return rows;
}

async function readPhysicalColumnM(spreadsheetId: string): Promise<Map<number, string>> {
  const { sheets } = getSheetsClients();
  const response = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'M2:M4' });
  const values = response.data.values ?? [];
  const byRow = new Map<number, string>();
  TARGET_ROW_NUMBERS.forEach((rowNumber, index) => {
    const cell = values[index]?.[0];
    byRow.set(rowNumber, typeof cell === 'string' ? cell : '');
  });
  return byRow;
}

async function main(): Promise<void> {
  console.log('[row-collision-audit] === step 1: synced jobs in sheet_sync_queue with sheet_row_number IN (2,3,4) ===');
  const candidates = await fetchCandidates();
  console.log(`[row-collision-audit]   total matching jobs: ${candidates.length}`);

  const distinctSheetIds = [...new Set(candidates.map((c) => c.google_sheet_id).filter((id): id is string => id !== null))];
  const sheetLabelById = new Map<string, string>();
  distinctSheetIds.forEach((id, index) => sheetLabelById.set(id, `sheet${String.fromCharCode(65 + index)}`));

  for (const c of candidates) {
    const sheetLabel = c.google_sheet_id ? (sheetLabelById.get(c.google_sheet_id) ?? '(unknown)') : '(none)';
    console.log(
      `[row-collision-audit]   queue_id=${c.queue_id}  telegram_message_id=${c.telegram_message_id}  status=${c.status}  ` +
        `sheet_row_number=${c.sheet_row_number}  synced_at=${c.synced_at ?? '(none)'}  attempts=${c.attempts}  ` +
        `group_id=${c.group_id}  group_name=${JSON.stringify(c.group_name)}  sheet_label=${sheetLabel}`,
    );
  }

  console.log(`[row-collision-audit]   distinct spreadsheets referenced by these jobs: ${distinctSheetIds.length}`);
  distinctSheetIds.forEach((id) => {
    console.log(`[row-collision-audit]     ${sheetLabelById.get(id)}: google_sheet_id_present=true`);
  });

  console.log('[row-collision-audit] === step 2: DB-side collision check (same spreadsheet + same sheet_row_number claimed by >1 job) ===');
  const dbCollisionKey = new Map<string, CollisionCandidateRow[]>();
  for (const c of candidates) {
    const key = `${c.google_sheet_id ?? '(none)'}:${c.sheet_row_number}`;
    const existing = dbCollisionKey.get(key) ?? [];
    existing.push(c);
    dbCollisionKey.set(key, existing);
  }
  for (const [key, rowsForKey] of dbCollisionKey) {
    if (rowsForKey.length > 1) {
      const [sheetId, rowNumber] = key.split(':');
      const sheetLabel = sheetId && sheetId !== '(none)' ? (sheetLabelById.get(sheetId) ?? '(unknown)') : '(none)';
      console.log(
        `[row-collision-audit]   COLLISION: sheet_label=${sheetLabel} sheet_row_number=${rowNumber} is claimed by ${rowsForKey.length} DB jobs: ` +
          rowsForKey.map((r) => `${r.queue_id} (telegram_message_id=${r.telegram_message_id}, synced_at=${r.synced_at ?? '(none)'})`).join(', '),
      );
    }
  }

  console.log('[row-collision-audit] === step 3: physical Sheet read (M2:M4) for each distinct spreadsheet ===');
  const physicalByLabel = new Map<string, Map<number, string>>();
  for (const sheetId of distinctSheetIds) {
    const label = sheetLabelById.get(sheetId)!;
    const physical = await readPhysicalColumnM(sheetId);
    physicalByLabel.set(label, physical);
    for (const rowNumber of TARGET_ROW_NUMBERS) {
      console.log(`[row-collision-audit]   ${label} M${rowNumber} physical value = ${physical.get(rowNumber) || '(blank)'}`);
    }
  }

  console.log('[row-collision-audit] === step 4: per-DB-job match against the physical M value at its recorded sheet_row_number ===');
  for (const c of candidates) {
    if (!c.google_sheet_id) {
      console.log(`[row-collision-audit]   queue_id=${c.queue_id}: no google_sheet_id on record — cannot check physical Sheet.`);
      continue;
    }
    const label = sheetLabelById.get(c.google_sheet_id)!;
    const physical = physicalByLabel.get(label);
    const physicalValueAtItsRow = physical?.get(c.sheet_row_number) ?? '';
    const matches = physicalValueAtItsRow === c.telegram_message_id;
    console.log(
      `[row-collision-audit]   queue_id=${c.queue_id}  telegram_message_id=${c.telegram_message_id}  sheet_label=${label}  ` +
        `sheet_row_number=${c.sheet_row_number}  physical_M_value_at_that_row=${physicalValueAtItsRow || '(blank)'}  ` +
        `db_matches_physical=${matches}`,
    );
  }

  console.log(
    '[row-collision-audit] DONE -- read-only, nothing was created, modified, or deleted. Interpretation of these facts ' +
      'is left to the caller; this script only reports what the DB and the Sheet each currently say.',
  );
}

main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : 'unknown error';
    console.error('[row-collision-audit] FAILED:', message.slice(0, 500));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
