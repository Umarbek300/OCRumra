/**
 * TEMPORARY ONE-OFF DIAGNOSTIC — not part of the production OCR/Sheets
 * pipeline. Never imported by src/, never wired into any worker.
 *
 * Purpose: forensic timeline for 6 specific sheet_sync_queue jobs the user
 * identified as having synced to sheet_row_number 2, 3, or 4 around
 * 2026-09-28 07:54 UTC, despite the deterministic upsertRowInSheet.ts fix
 * already being deployed. This only reports each job's own DB timeline
 * (created_at, updated_at, synced_at, attempts) plus its current state — it
 * draws no conclusion itself.
 *
 * READ-ONLY: a single SELECT against sheet_sync_queue by explicit id list.
 * No INSERT/UPDATE/DELETE anywhere in this file. No Sheets API call. No
 * service interaction. No Tesseract/local OCR.
 *
 * PRIVACY: only ids, statuses, timestamps, and attempts are printed. No
 * passport/OCR/Telegram field content is ever logged.
 */
import { pool } from '../src/db/pool.js';

const TARGET_QUEUE_IDS = [
  '3c1133fb-bcfd-401a-97c7-925c1410b630',
  '6014ea93-8c37-41d8-91b8-88f0395ad3f5',
  'fba10826-7357-43e1-982e-4d320d3a9208',
  '88fd503d-fa3a-4052-a25a-16dab52d2f0d',
  '8c77e99f-e0ca-4871-be0d-73b30c84a1f4',
  '267650c1-a68b-4009-bf7b-9e21ef1a8f76',
];

interface TimelineRow {
  id: string;
  telegram_message_id: string;
  status: string;
  sheet_row_number: number | null;
  attempts: number;
  // pg returns timestamptz columns as Date objects, not strings, by default
  // -- typed here as the actual runtime shape (never plain string) so
  // sorting/formatting code isn't tempted to assume string methods exist.
  created_at: string | Date;
  updated_at: string | Date;
  synced_at: string | Date | null;
}

/** Safe sort key for a pg timestamptz value that may arrive as a Date, a string, or null. */
function toSortableTime(value: string | Date | null): number {
  return value ? new Date(value).getTime() : 0;
}

async function main(): Promise<void> {
  console.log('[row234-forensic-timeline] === the 6 target queue rows, ordered by created_at ===');
  const { rows } = await pool.query<TimelineRow>(
    `SELECT id, telegram_message_id, status, sheet_row_number, attempts, created_at, updated_at, synced_at
     FROM sheet_sync_queue
     WHERE id = ANY($1::uuid[])
     ORDER BY created_at`,
    [TARGET_QUEUE_IDS],
  );

  console.log(`[row234-forensic-timeline]   found ${rows.length} of ${TARGET_QUEUE_IDS.length} requested ids`);
  const foundIds = new Set(rows.map((r) => r.id));
  for (const id of TARGET_QUEUE_IDS) {
    if (!foundIds.has(id)) {
      console.log(`[row234-forensic-timeline]   MISSING: queue id ${id} not found in sheet_sync_queue`);
    }
  }

  for (const r of rows) {
    console.log(
      `[row234-forensic-timeline]   queue_id=${r.id}\n` +
        `[row234-forensic-timeline]     telegram_message_id=${r.telegram_message_id}\n` +
        `[row234-forensic-timeline]     status=${r.status}\n` +
        `[row234-forensic-timeline]     sheet_row_number=${r.sheet_row_number ?? '(none)'}\n` +
        `[row234-forensic-timeline]     attempts=${r.attempts}\n` +
        `[row234-forensic-timeline]     created_at=${r.created_at}\n` +
        `[row234-forensic-timeline]     updated_at=${r.updated_at}\n` +
        `[row234-forensic-timeline]     synced_at=${r.synced_at ?? '(none)'}`,
    );
  }

  console.log('[row234-forensic-timeline] === grouped by sheet_row_number, ordered by synced_at (to see write ORDER within each row) ===');
  const byRowNumber = new Map<number, TimelineRow[]>();
  for (const r of rows) {
    if (r.sheet_row_number === null) continue;
    const existing = byRowNumber.get(r.sheet_row_number) ?? [];
    existing.push(r);
    byRowNumber.set(r.sheet_row_number, existing);
  }
  for (const [rowNumber, group] of [...byRowNumber.entries()].sort((a, b) => a[0] - b[0])) {
    const sorted = [...group].sort((a, b) => toSortableTime(a.synced_at) - toSortableTime(b.synced_at));
    console.log(`[row234-forensic-timeline]   sheet_row_number=${rowNumber}: ${sorted.length} job(s) among the 6, in synced_at order:`);
    for (const r of sorted) {
      console.log(`[row234-forensic-timeline]     queue_id=${r.id}  synced_at=${r.synced_at ?? '(none)'}  telegram_message_id=${r.telegram_message_id}`);
    }
  }

  console.log('[row234-forensic-timeline] DONE -- read-only, nothing was created, modified, or deleted.');
}

main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : 'unknown error';
    console.error('[row234-forensic-timeline] FAILED:', message.slice(0, 500));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
