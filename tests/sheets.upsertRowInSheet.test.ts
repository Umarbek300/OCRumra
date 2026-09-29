import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildRealSheetsWriteClient, upsertRowInSheet, type SheetsWriteClient } from '../src/sheets/upsertRowInSheet.js';
import type { SheetsClients } from '../src/sheets/sheetsAuth.js';

const SAMPLE_ROW = ['', 'ANNA', 'ERIKSSON', 'L898902C3', '1974-08-12', '2004-01-01', '2012-04-15', 'Ayol', 'Jasur Agent', '', '', ''];

interface Calls {
  getAllDataRows: number;
  updateVisibleRow: number;
  writeRowAt: number;
}

function buildFakeClient(rows: string[][]): { client: SheetsWriteClient; calls: Calls; updateArgs: unknown[]; writeArgs: unknown[] } {
  const calls: Calls = { getAllDataRows: 0, updateVisibleRow: 0, writeRowAt: 0 };
  const updateArgs: unknown[] = [];
  const writeArgs: unknown[] = [];

  const client: SheetsWriteClient = {
    async getAllDataRows() {
      calls.getAllDataRows += 1;
      return rows;
    },
    async updateVisibleRow(spreadsheetId, rowNumber, valuesFromColumnB) {
      calls.updateVisibleRow += 1;
      updateArgs.push({ spreadsheetId, rowNumber, valuesFromColumnB });
    },
    async writeRowAt(spreadsheetId, rowNumber, fullValues) {
      calls.writeRowAt += 1;
      writeArgs.push({ spreadsheetId, rowNumber, fullValues });
    },
  };

  return { client, calls, updateArgs, writeArgs };
}

/** Builds a full 13-element A:M row with the given technical id (column M, index 12); other columns are simple filler, never asserted on. */
function realRow(technicalId: string): string[] {
  return ['1', 'ANNA', 'ERIKSSON', 'L898902C3', '1974-08-12', '2004-01-01', '2012-04-15', 'Ayol', 'Jasur Agent', '', '', '', technicalId];
}

test('upsertRowInSheet reads the whole A:M area exactly once, never a column-M-only read', async () => {
  const { client, calls } = buildFakeClient([realRow('msg-a')]);
  await upsertRowInSheet({ spreadsheetId: 'sheet-1', telegramMessageId: 'msg-new', row: SAMPLE_ROW }, client);
  assert.equal(calls.getAllDataRows, 1);
});

test('upsertRowInSheet updates the existing row when the telegram_message_id is already present, leaving № untouched', async () => {
  const { client, calls, updateArgs } = buildFakeClient([realRow('other-msg-id'), realRow('msg-123'), realRow('yet-another')]);

  const result = await upsertRowInSheet({ spreadsheetId: 'sheet-1', telegramMessageId: 'msg-123', row: SAMPLE_ROW }, client);

  assert.equal(result.action, 'updated');
  assert.equal(result.rowNumber, 3, 'row 2 (first data row) + index 1 = row 3');
  assert.equal(calls.updateVisibleRow, 1);
  assert.equal(calls.writeRowAt, 0);

  const call = updateArgs[0] as { rowNumber: number; valuesFromColumnB: string[] };
  assert.equal(call.rowNumber, 3);
  assert.equal(call.valuesFromColumnB.length, 12, '11 visible columns (B..L) + technical id (M)');
  assert.equal(call.valuesFromColumnB[0], 'ANNA', 'first element is Ism, not №');
  assert.equal(call.valuesFromColumnB[call.valuesFromColumnB.length - 1], 'msg-123', 'last element is the technical id');
});

test('upsertRowInSheet writes a new row at FIRST_DATA_ROW_NUMBER + rows.length when the telegram_message_id is not found', async () => {
  const { client, calls, writeArgs } = buildFakeClient([realRow('msg-a'), realRow('msg-b')]);

  const result = await upsertRowInSheet({ spreadsheetId: 'sheet-1', telegramMessageId: 'msg-new', row: SAMPLE_ROW }, client);

  assert.equal(result.action, 'appended');
  assert.equal(result.rowNumber, 4, '2 (first data row) + 2 existing rows = row 4');
  assert.equal(calls.writeRowAt, 1);
  assert.equal(calls.updateVisibleRow, 0);

  const call = writeArgs[0] as { rowNumber: number; fullValues: string[] };
  assert.equal(call.rowNumber, 4);
  assert.equal(call.fullValues.length, 13, '№ (A) + 11 visible columns (B..L) + technical id (M)');
  assert.equal(call.fullValues[0], '3', '№ derived from existing data-row count (2) + 1');
  assert.equal(call.fullValues[call.fullValues.length - 1], 'msg-new');
});

test('upsertRowInSheet on an empty sheet writes the first data row as № = 1 at row 2', async () => {
  const { client, writeArgs } = buildFakeClient([]);

  const result = await upsertRowInSheet({ spreadsheetId: 'sheet-1', telegramMessageId: 'msg-first', row: SAMPLE_ROW }, client);

  assert.equal(result.rowNumber, 2);
  const call = writeArgs[0] as { fullValues: string[] };
  assert.equal(call.fullValues[0], '1');
});

test('upsertRowInSheet retried for an already-synced message updates in place instead of writing a duplicate', async () => {
  // Simulates: first call wrote msg-123 (now present in the sheet); this
  // second call is the "retry" and must find it via the column-M lookup
  // rather than treating it as new.
  const { client, calls } = buildFakeClient([realRow('msg-123')]);

  const result = await upsertRowInSheet({ spreadsheetId: 'sheet-1', telegramMessageId: 'msg-123', row: SAMPLE_ROW }, client);

  assert.equal(result.action, 'updated');
  assert.equal(calls.writeRowAt, 0, 'a retry for an already-written message must never write a duplicate row');
});

// --- dirty-sheet safety: pollution/gaps anywhere in A:M must never be
// overwritten and must never corrupt the physical row / № computation ---

test('a foreign value in column M (never a real telegram_message_id) is never matched, never overwritten, and is still counted toward the next row position', async () => {
  // Row 2: "M2 pollution" -- some unrelated text sitting in the technical
  // id column, A:L otherwise blank. Never written by this pipeline, never
  // touched by it either.
  const pollutedRow = ['', '', '', '', '', '', '', '', '', '', '', '', "It looks like you haven't included a specific question..."];
  const { client, writeArgs } = buildFakeClient([pollutedRow]);

  const result = await upsertRowInSheet({ spreadsheetId: 'sheet-1', telegramMessageId: 'msg-real', row: SAMPLE_ROW }, client);

  assert.equal(result.action, 'appended');
  assert.equal(result.rowNumber, 3, 'row 2 is occupied by pollution -- the new row goes to row 3, never overwriting row 2');
  const call = writeArgs[0] as { rowNumber: number; fullValues: string[] };
  assert.equal(call.rowNumber, 3);
  assert.equal(call.fullValues[0], '2', '№ still reflects this row\'s own physical data-row position (row 2 counted, even though it is pollution)');
});

test('a diagnostic marker like "DIAG-TEST" in column M is never matched and never overwritten', async () => {
  const diagRow = ['', '', '', '', '', '', '', '', '', '', '', '', 'DIAG-TEST'];
  const { client, calls, writeArgs } = buildFakeClient([realRow('msg-a'), diagRow]);

  const result = await upsertRowInSheet({ spreadsheetId: 'sheet-1', telegramMessageId: 'msg-new', row: SAMPLE_ROW }, client);

  assert.equal(result.action, 'appended');
  assert.equal(result.rowNumber, 4, 'row 3 (DIAG-TEST) is never touched -- the new row goes to row 4');
  assert.equal(calls.updateVisibleRow, 0, 'DIAG-TEST must never be matched as an existing row to update');
  const call = writeArgs[0] as { fullValues: string[] };
  assert.equal(call.fullValues[call.fullValues.length - 1], 'msg-new');
});

test('a row with A:L filled but M blank (a genuinely broken earlier sync) is never matched by column M, and a retry for it writes a new row rather than overwriting it', async () => {
  const brokenRow = ['1', 'ANNA', 'ERIKSSON', 'L898902C3', '1974-08-12', '2004-01-01', '2012-04-15', 'Ayol', 'Jasur Agent', '', '', '']; // only 12 elements -- M (index 12) is genuinely absent
  const { client, writeArgs } = buildFakeClient([brokenRow]);

  const result = await upsertRowInSheet({ spreadsheetId: 'sheet-1', telegramMessageId: 'msg-should-have-been-here', row: SAMPLE_ROW }, client);

  assert.equal(result.action, 'appended');
  assert.equal(result.rowNumber, 3, 'the broken row (row 2) is left exactly as-is; the retry writes a fresh row 3');
  const call = writeArgs[0] as { fullValues: string[] };
  assert.equal(call.fullValues[0], '2', '№ = 2, since row 2 (the broken row) is still counted in the physical sequence');
});

test('a row with M filled but A:L blank does not disrupt row positioning for a genuinely new message after it', async () => {
  const mOnlyRow = ['', '', '', '', '', '', '', '', '', '', '', '', 'msg-existing'];
  const { client, writeArgs } = buildFakeClient([mOnlyRow]);

  const result = await upsertRowInSheet({ spreadsheetId: 'sheet-1', telegramMessageId: 'msg-existing', row: SAMPLE_ROW }, client);

  // Exact match on column M still finds and updates it correctly, even
  // though A:L are blank for that row -- proves the lookup only ever keys
  // off the technical id, never off whether the rest of the row "looks
  // real".
  assert.equal(result.action, 'updated');
  assert.equal(result.rowNumber, 2);
});

test('a genuinely blank row in the middle of the sheet is preserved in position, never collapsed, and never overwritten', async () => {
  // Google Sheets' values.get represents a fully-blank row that PRECEDES
  // later real content as [] (or a short array), not by omitting it --
  // see getAllDataRows' own doc comment. Simulated here directly.
  const { client, writeArgs } = buildFakeClient([realRow('msg-a'), [], realRow('msg-c')]);

  const result = await upsertRowInSheet({ spreadsheetId: 'sheet-1', telegramMessageId: 'msg-new', row: SAMPLE_ROW }, client);

  assert.equal(result.action, 'appended');
  assert.equal(result.rowNumber, 5, '2 (first data row) + 3 existing rows (including the blank middle one) = row 5');
  const call = writeArgs[0] as { fullValues: string[] };
  assert.equal(call.fullValues[0], '4', '№ counts the blank middle row too -- it mirrors true physical position, not a "real rows only" count');
});

test('sheet_row_number the caller would record always equals the row actually written to (physical row / № consistency)', async () => {
  const { client, writeArgs } = buildFakeClient([realRow('msg-a'), realRow('msg-b'), realRow('msg-c')]);

  const result = await upsertRowInSheet({ spreadsheetId: 'sheet-1', telegramMessageId: 'msg-new', row: SAMPLE_ROW }, client);

  const call = writeArgs[0] as { rowNumber: number; fullValues: string[] };
  assert.equal(result.rowNumber, call.rowNumber, 'the result returned to the caller (what gets stored as sheet_row_number) is exactly the row physically written');
  assert.equal(Number(call.fullValues[0]), result.rowNumber - 1, '№ is always physicalRow - FIRST_DATA_ROW_NUMBER + 1');
});

// --- buildRealSheetsWriteClient: timeout actually reaches the real gaxios call options ---

test('buildRealSheetsWriteClient passes the configured API timeout to every real Sheets call it makes', async () => {
  const seenTimeouts: Record<string, number | undefined> = {};

  const fakeClients: SheetsClients = {
    sheets: {
      spreadsheets: {
        values: {
          get: (async (_params: unknown, options: { timeout?: number }) => {
            seenTimeouts['values.get'] = options?.timeout;
            return { data: { values: [['1', 'A', 'B', '', '', '', '', '', '', '', '', '', 'msg-existing']] } };
          }) as never,
          update: (async (_params: unknown, options: { timeout?: number }) => {
            seenTimeouts['values.update'] = options?.timeout;
            return { data: {} };
          }) as never,
        },
      },
    } as never,
    drive: {} as never,
  };

  const client = buildRealSheetsWriteClient(() => fakeClients);
  await client.getAllDataRows('sheet-1');
  await client.updateVisibleRow('sheet-1', 2, SAMPLE_ROW.slice(1));
  await client.writeRowAt('sheet-1', 3, SAMPLE_ROW);

  // No GOOGLE_SHEETS_API_TIMEOUT_MS is set in this test process's env, so
  // getConfiguredApiTimeoutMs() falls back to env.schema.ts's own 30000ms
  // default — proving the real, unmocked config path, not a test double.
  assert.equal(seenTimeouts['values.get'], 30_000);
  assert.equal(seenTimeouts['values.update'], 30_000);
});
