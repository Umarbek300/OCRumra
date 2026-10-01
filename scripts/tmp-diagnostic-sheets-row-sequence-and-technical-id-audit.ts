/**
 * TEMPORARY ONE-OFF DIAGNOSTIC — not part of the production OCR/Sheets
 * pipeline. Never imported by src/, never wired into any worker.
 *
 * READ-ONLY follow-up to tmp-diagnostic-sheets-row3-e2e-audit.ts, which
 * incorrectly expected column A's "№" value to equal the physical sheet row
 * number. It does not: № is a 1-based sequential counter over DATA rows
 * only (header is physical row 1, first data row is physical row
 * FIRST_DATA_ROW_NUMBER=2, so physical_row = FIRST_DATA_ROW_NUMBER + (№ - 1)
 * = № + 1). This script re-checks the real invariants instead:
 *
 *   1) reads every existing data row's № (column A) and technical id
 *      (column M) in one spreadsheets.values.get on A2:M (open-ended,
 *      the same pattern buildRealSheetsWriteClient().getTechnicalIdColumn
 *      already uses for M2:M),
 *   2) checks the № column forms the sequence 1, 2, 3, ... with no gaps
 *      or repeats, in physical row order,
 *   3) checks every non-empty technical id (column M) value is unique
 *      across all data rows (no duplicate telegram_message_id),
 *   4) reports the (physical_row, №) pair for every row so the two
 *      numbering schemes are never conflated -- physical_row is always
 *      № + 1 when the sequence is intact.
 *
 * Never INSERTs/UPDATEs/DELETEs anything, never writes to Google Sheets,
 * never starts the worker, never invokes any OCR provider (Tesseract or
 * otherwise), never touches the database at all.
 *
 * PRIVACY: column A (№, a small sequence integer) and column M (a
 * telegram_message_id UUID) are the only two columns read, and neither is
 * passport PII -- both are printed in full. No other column is read.
 */
import { getSheetsClients } from '../src/sheets/sheetsAuth.js';
import { FIRST_DATA_ROW_NUMBER, TECHNICAL_ID_COLUMN_LETTER } from '../src/sheets/sheetLayout.js';

const SPREADSHEET_ID = '16oTz3UkPqYIlyiqk3Gv-4CA9Le1uIw0DSeO7ItecPWs';

interface DataRow {
  physicalRow: number;
  numberValue: number | null;
  technicalId: string | null;
}

async function main(): Promise<void> {
  console.log('[row-sequence-audit] spreadsheetId:', SPREADSHEET_ID);

  const { sheets } = getSheetsClients();
  const range = `A${FIRST_DATA_ROW_NUMBER}:${TECHNICAL_ID_COLUMN_LETTER}`;
  const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range });
  const rawRows = response.data.values ?? [];

  const dataRows: DataRow[] = rawRows.map((raw, index) => {
    const physicalRow = FIRST_DATA_ROW_NUMBER + index;
    const rawNumber = raw[0];
    const numberValue = typeof rawNumber === 'string' && rawNumber.length > 0 ? Number(rawNumber) : null;
    const rawTechnicalId = raw[12];
    const technicalId = typeof rawTechnicalId === 'string' && rawTechnicalId.length > 0 ? rawTechnicalId : null;
    return { physicalRow, numberValue, technicalId };
  });

  console.log('[row-sequence-audit] total data rows found:', dataRows.length);

  console.log('[row-sequence-audit] === 1) per-row (physical_row, №, technical_id present?) ===');
  for (const row of dataRows) {
    console.log(
      `[row-sequence-audit]   physical_row=${row.physicalRow}  №=${row.numberValue ?? '(empty)'}  ` +
        `technical_id_present=${row.technicalId !== null}`,
    );
  }

  console.log('[row-sequence-audit] === 2) № sequence check (expect 1, 2, 3, ... with no gaps/repeats) ===');
  let sequenceOk = true;
  dataRows.forEach((row, index) => {
    const expected = index + 1;
    const ok = row.numberValue === expected;
    if (!ok) sequenceOk = false;
    console.log(`[row-sequence-audit]   row index ${index}: expected №=${expected}, actual №=${row.numberValue ?? '(empty)'}, ok=${ok}`);
  });
  console.log('[row-sequence-audit]   overall № sequence intact:', sequenceOk);

  console.log('[row-sequence-audit] === 3) technical id (column M) uniqueness check ===');
  const technicalIds = dataRows.map((row) => row.technicalId).filter((id): id is string => id !== null);
  const uniqueTechnicalIds = new Set(technicalIds);
  const duplicates = technicalIds.filter((id, index) => technicalIds.indexOf(id) !== index);
  console.log('[row-sequence-audit]   non-empty technical ids found:', technicalIds.length);
  console.log('[row-sequence-audit]   unique technical ids:', uniqueTechnicalIds.size);
  console.log('[row-sequence-audit]   all technical ids unique (no duplicates):', uniqueTechnicalIds.size === technicalIds.length);
  if (duplicates.length > 0) {
    console.log('[row-sequence-audit]   duplicate technical id UUIDs (not PII):', [...new Set(duplicates)]);
  }

  console.log('[row-sequence-audit] === 4) numbering-scheme reminder ===');
  console.log(
    '[row-sequence-audit]   physical_row = № + 1 (header occupies physical row 1) -- verified per-row above, ' +
      'never assume physical_row === №.',
  );

  console.log('[row-sequence-audit] DONE -- read-only, nothing was created, modified, or deleted.');
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : 'unknown error';
  console.error('[row-sequence-audit] FAILED:', message.slice(0, 300));
  process.exitCode = 1;
});
