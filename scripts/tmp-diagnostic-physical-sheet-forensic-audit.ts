/**
 * TEMPORARY ONE-OFF DIAGNOSTIC — not part of the production OCR/Sheets
 * pipeline. Never imported by src/, never wired into any worker.
 *
 * Purpose: final forensic step in the row 2/3/4 collision investigation --
 * directly inspect the PHYSICAL current state of the production Sheet
 * (16oTz3UkPqYIlyiqk3Gv-4CA9Le1uIw0DSeO7ItecPWs, already visible in this
 * conversation's own pasted journal output) to see exactly what rows 1-30
 * currently contain, how many rows values.get("A2:M") -- the EXACT range
 * upsertRowInSheet.ts itself reads -- currently returns, and cross-check
 * every non-empty column-M technical id against the 6 forensic
 * sheet_sync_queue jobs' own recorded sheet_row_number.
 *
 * PRIVACY DEVIATION FROM THE LITERAL REQUEST, BY DESIGN: the standing rule
 * for every diagnostic this whole engagement has been "never print actual
 * passport PII -- only booleans, lengths, counts, ids, or metadata" (this
 * has held even when earlier requests asked to see "A:M values" -- see
 * every prior tmp-diagnostic-sheets-*.ts script). Column M is always safe
 * to print in full: it holds either the pipeline's own telegram_message_id
 * UUID, or one of the two already-known, already-discussed pollution
 * markers (the AI-chatbot-style text and "DIAG-TEST"), never a passport
 * field. Row 1 (the header row) is also safe in full -- it's fixed column
 * labels, not user data. Columns A:L on any DATA row, however, can be a
 * REAL synced passport's name/passport number/dates/agent/amounts, so this
 * script reports only whether each of A:L is non-empty (and its length) on
 * every row -- never the literal cell text -- which still answers every
 * structural question this audit needs (row count, which rows are blank,
 * which rows collide) without a passport ever appearing in a terminal
 * transcript.
 *
 * READ-ONLY, end to end:
 *   - Google Sheets: only spreadsheets.get (metadata) and spreadsheets.
 *     values.get (two reads: the tab-qualified Sheet1!A1:M30 the user asked
 *     for, and the exact unprefixed "A2:M" upsertRowInSheet.ts itself uses,
 *     to answer "how many rows does rows.length actually see"). Never
 *     values.update, never values.append, never any provisioning call.
 *   - Postgres: only SELECT against sheet_sync_queue for the 6 already-
 *     known forensic job ids. No INSERT/UPDATE/DELETE anywhere.
 *   - No service is started/stopped/restarted/reloaded. No queue status is
 *     written. No Tesseract/local OCR is invoked. upsertRowInSheet.ts is
 *     not touched.
 */
import { pool } from '../src/db/pool.js';
import { getSheetsClients } from '../src/sheets/sheetsAuth.js';

const SPREADSHEET_ID = '16oTz3UkPqYIlyiqk3Gv-4CA9Le1uIw0DSeO7ItecPWs';
const VISIBLE_COLUMN_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'] as const;
const HIGHLIGHT_ROWS = [1, 2, 3, 4, 5, 16, 17];

const FORENSIC_QUEUE_IDS = [
  '3c1133fb-bcfd-401a-97c7-925c1410b630',
  '6014ea93-8c37-41d8-91b8-88f0395ad3f5',
  'fba10826-7357-43e1-982e-4d320d3a9208',
  '88fd503d-fa3a-4052-a25a-16dab52d2f0d',
  '8c77e99f-e0ca-4871-be0d-73b30c84a1f4',
  '267650c1-a68b-4009-bf7b-9e21ef1a8f76',
];

async function reportSpreadsheetMetadata(): Promise<void> {
  console.log('[physical-sheet-forensic-audit] === step 1: spreadsheet + tab metadata (read-only spreadsheets.get) ===');
  const { sheets } = getSheetsClients();
  const response = await sheets.spreadsheets.get({
    spreadsheetId: SPREADSHEET_ID,
    fields: 'properties.title,sheets.properties',
  });
  console.log(`[physical-sheet-forensic-audit]   spreadsheet title: ${response.data.properties?.title ?? '(unknown)'}`);
  for (const sheet of response.data.sheets ?? []) {
    const p = sheet.properties;
    console.log(
      `[physical-sheet-forensic-audit]   tab: sheetId(gid)=${p?.sheetId}  title=${JSON.stringify(p?.title)}  ` +
        `rowCount=${p?.gridProperties?.rowCount ?? '(unknown)'}  columnCount=${p?.gridProperties?.columnCount ?? '(unknown)'}`,
    );
  }
}

function describeDataRow(rowNumber: number, row: string[]): void {
  const cellDescriptions = VISIBLE_COLUMN_LETTERS.map((letter, index) => {
    const cell = row[index];
    const nonEmpty = !!cell && cell.length > 0;
    return `${letter}:${nonEmpty ? `len${cell!.length}` : 'empty'}`;
  }).join('  ');
  const technicalId = row[12] ?? '';
  console.log(
    `[physical-sheet-forensic-audit]   row ${rowNumber}: [${cellDescriptions}]  M(technical_id)=${technicalId.length > 0 ? technicalId : '(empty)'}`,
  );
}

async function reportFullGrid(): Promise<{ a1m30Rows: string[][]; a2mRows: string[][] }> {
  console.log('[physical-sheet-forensic-audit] === step 2: Sheet1!A1:M30 physical content (A:L as non_empty/length only, M in full) ===');
  const { sheets } = getSheetsClients();

  const a1m30Response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Sheet1!A1:M30' });
  const a1m30Rows = (a1m30Response.data.values ?? []) as string[][];
  console.log(`[physical-sheet-forensic-audit]   Sheet1!A1:M30 returned array length: ${a1m30Rows.length}`);

  const headerRow = a1m30Rows[0] ?? [];
  console.log(`[physical-sheet-forensic-audit]   row 1 (header, full text -- not user data): ${JSON.stringify(headerRow)}`);

  for (let i = 1; i < a1m30Rows.length; i += 1) {
    describeDataRow(i + 1, a1m30Rows[i] ?? []);
  }

  console.log('[physical-sheet-forensic-audit]   --- highlighted rows requested explicitly ---');
  for (const rowNumber of HIGHLIGHT_ROWS) {
    const row = a1m30Rows[rowNumber - 1];
    if (row === undefined) {
      console.log(`[physical-sheet-forensic-audit]   row ${rowNumber}: NOT PRESENT in the returned array (beyond what Sheets returned)`);
      continue;
    }
    if (rowNumber === 1) {
      console.log(`[physical-sheet-forensic-audit]   row ${rowNumber} (header, full text): ${JSON.stringify(row)}`);
    } else {
      describeDataRow(rowNumber, row);
    }
  }

  console.log('[physical-sheet-forensic-audit] === step 3: exactly the range upsertRowInSheet.ts itself uses ("A2:M", unprefixed) ===');
  const a2mResponse = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'A2:M' });
  const a2mRows = (a2mResponse.data.values ?? []) as string[][];
  console.log(`[physical-sheet-forensic-audit]   values.get("A2:M") returned array length (== rows.length in upsertRowInSheet.ts): ${a2mRows.length}`);
  console.log(`[physical-sheet-forensic-audit]   => the NEXT new row upsertRowInSheet.ts would compute right now: ${2 + a2mRows.length}`);

  return { a1m30Rows, a2mRows };
}

function reportAllTechnicalIds(a1m30Rows: string[][]): Map<number, string> {
  console.log('[physical-sheet-forensic-audit] === step 4: every non-empty column-M technical id, by physical row number ===');
  const idsByRow = new Map<number, string>();
  a1m30Rows.forEach((row, index) => {
    const rowNumber = index + 1;
    if (rowNumber === 1) return; // header
    const technicalId = row[12];
    if (technicalId && technicalId.length > 0) {
      idsByRow.set(rowNumber, technicalId);
      console.log(`[physical-sheet-forensic-audit]   row ${rowNumber}: M=${technicalId}`);
    }
  });
  if (idsByRow.size === 0) {
    console.log('[physical-sheet-forensic-audit]   (no non-empty M values found in A1:M30)');
  }
  return idsByRow;
}

interface ForensicJobRow {
  id: string;
  telegram_message_id: string;
  status: string;
  sheet_row_number: number | null;
  synced_at: Date | string | null;
}

async function crossCheckForensicJobs(idsByRow: Map<number, string>): Promise<void> {
  console.log('[physical-sheet-forensic-audit] === step 5: the 6 forensic jobs\' DB sheet_row_number vs. the PHYSICAL M value just read ===');
  const { rows } = await pool.query<ForensicJobRow>(
    `SELECT id, telegram_message_id, status, sheet_row_number, synced_at
     FROM sheet_sync_queue
     WHERE id = ANY($1::uuid[])
     ORDER BY synced_at`,
    [FORENSIC_QUEUE_IDS],
  );

  for (const job of rows) {
    if (job.sheet_row_number === null) {
      console.log(`[physical-sheet-forensic-audit]   queue_id=${job.id}: sheet_row_number is null -- nothing to compare.`);
      continue;
    }
    const physicalValue = idsByRow.get(job.sheet_row_number) ?? '(empty at that row)';
    const matches = physicalValue === job.telegram_message_id;
    console.log(
      `[physical-sheet-forensic-audit]   queue_id=${job.id}  telegram_message_id=${job.telegram_message_id}  ` +
        `db_sheet_row_number=${job.sheet_row_number}  physical_M_at_that_row=${physicalValue}  matches=${matches}`,
    );
  }
}

async function main(): Promise<void> {
  await reportSpreadsheetMetadata();
  const { a1m30Rows } = await reportFullGrid();
  const idsByRow = reportAllTechnicalIds(a1m30Rows);
  await crossCheckForensicJobs(idsByRow);
  console.log('[physical-sheet-forensic-audit] DONE -- read-only, nothing was created, modified, or deleted.');
}

main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : 'unknown error';
    console.error('[physical-sheet-forensic-audit] FAILED:', message.slice(0, 500));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
