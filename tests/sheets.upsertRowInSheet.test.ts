import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildRealSheetsWriteClient, parseRowNumberFromA1Range, upsertRowInSheet, type SheetsWriteClient } from '../src/sheets/upsertRowInSheet.js';
import type { SheetsClients } from '../src/sheets/sheetsAuth.js';

const SAMPLE_ROW = ['', 'ANNA', 'ERIKSSON', 'L898902C3', '1974-08-12', '2004-01-01', '2012-04-15', 'Ayol', 'Jasur Agent', '', '', ''];

interface Calls {
  getTechnicalIdColumn: number;
  updateVisibleRow: number;
  appendFullRow: number;
}

interface FakeClientOptions {
  idColumn: string[];
  appendRowNumber?: number;
}

function buildFakeClient(options: FakeClientOptions): { client: SheetsWriteClient; calls: Calls; updateArgs: unknown[]; appendArgs: unknown[] } {
  const calls: Calls = { getTechnicalIdColumn: 0, updateVisibleRow: 0, appendFullRow: 0 };
  const updateArgs: unknown[] = [];
  const appendArgs: unknown[] = [];

  const client: SheetsWriteClient = {
    async getTechnicalIdColumn() {
      calls.getTechnicalIdColumn += 1;
      return options.idColumn;
    },
    async updateVisibleRow(spreadsheetId, rowNumber, valuesFromColumnB) {
      calls.updateVisibleRow += 1;
      updateArgs.push({ spreadsheetId, rowNumber, valuesFromColumnB });
    },
    async appendFullRow(spreadsheetId, fullValues) {
      calls.appendFullRow += 1;
      appendArgs.push({ spreadsheetId, fullValues });
      return { rowNumber: options.appendRowNumber ?? options.idColumn.length + 2 };
    },
  };

  return { client, calls, updateArgs, appendArgs };
}

test('parseRowNumberFromA1Range extracts the row number from a Sheets updatedRange string', () => {
  assert.equal(parseRowNumberFromA1Range('Sheet1!A15:M15'), 15);
  assert.equal(parseRowNumberFromA1Range('Sheet1!A2:M2'), 2);
});

test('parseRowNumberFromA1Range returns null for an unparseable or missing range', () => {
  assert.equal(parseRowNumberFromA1Range(undefined), null);
  assert.equal(parseRowNumberFromA1Range(null), null);
  assert.equal(parseRowNumberFromA1Range('not-a-range'), null);
});

test('upsertRowInSheet updates the existing row when the telegram_message_id is already present, leaving № untouched', async () => {
  const { client, calls, updateArgs } = buildFakeClient({ idColumn: ['other-msg-id', 'msg-123', 'yet-another'] });

  const result = await upsertRowInSheet(
    { spreadsheetId: 'sheet-1', telegramMessageId: 'msg-123', row: SAMPLE_ROW },
    client,
  );

  assert.equal(result.action, 'updated');
  assert.equal(result.rowNumber, 3, 'row 2 (first data row) + index 1 = row 3');
  assert.equal(calls.updateVisibleRow, 1);
  assert.equal(calls.appendFullRow, 0);

  const call = updateArgs[0] as { rowNumber: number; valuesFromColumnB: string[] };
  assert.equal(call.rowNumber, 3);
  assert.equal(call.valuesFromColumnB.length, 12, '11 visible columns (B..L) + technical id (M)');
  assert.equal(call.valuesFromColumnB[0], 'ANNA', 'first element is Ism, not №');
  assert.equal(call.valuesFromColumnB[call.valuesFromColumnB.length - 1], 'msg-123', 'last element is the technical id');
});

test('upsertRowInSheet appends a new row when the telegram_message_id is not found', async () => {
  const { client, calls, appendArgs } = buildFakeClient({ idColumn: ['msg-a', 'msg-b'], appendRowNumber: 4 });

  const result = await upsertRowInSheet(
    { spreadsheetId: 'sheet-1', telegramMessageId: 'msg-new', row: SAMPLE_ROW },
    client,
  );

  assert.equal(result.action, 'appended');
  assert.equal(result.rowNumber, 4);
  assert.equal(calls.appendFullRow, 1);
  assert.equal(calls.updateVisibleRow, 0);

  const call = appendArgs[0] as { fullValues: string[] };
  assert.equal(call.fullValues.length, 13, '№ (A) + 11 visible columns (B..L) + technical id (M)');
  assert.equal(call.fullValues[0], '3', '№ derived from existing data-row count (2) + 1');
  assert.equal(call.fullValues[call.fullValues.length - 1], 'msg-new');
});

test('upsertRowInSheet on an empty sheet appends the first data row as № = 1', async () => {
  const { client, appendArgs } = buildFakeClient({ idColumn: [], appendRowNumber: 2 });

  await upsertRowInSheet({ spreadsheetId: 'sheet-1', telegramMessageId: 'msg-first', row: SAMPLE_ROW }, client);

  const call = appendArgs[0] as { fullValues: string[] };
  assert.equal(call.fullValues[0], '1');
});

test('upsertRowInSheet retried for an already-synced message updates in place instead of appending a duplicate', async () => {
  // Simulates: first call appended msg-123 (now present in the sheet's id
  // column); this second call is the "retry" and must find it via the
  // column-M lookup rather than re-appending.
  const { client, calls } = buildFakeClient({ idColumn: ['msg-123'] });

  const result = await upsertRowInSheet(
    { spreadsheetId: 'sheet-1', telegramMessageId: 'msg-123', row: SAMPLE_ROW },
    client,
  );

  assert.equal(result.action, 'updated');
  assert.equal(calls.appendFullRow, 0, 'a retry for an already-written message must never append a duplicate row');
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
            return { data: { values: [['msg-existing']] } };
          }) as never,
          update: (async (_params: unknown, options: { timeout?: number }) => {
            seenTimeouts['values.update'] = options?.timeout;
            return { data: {} };
          }) as never,
          append: (async (_params: unknown, options: { timeout?: number }) => {
            seenTimeouts['values.append'] = options?.timeout;
            return { data: { updates: { updatedRange: 'Sheet1!A3:M3' } } };
          }) as never,
        },
      },
    } as never,
    drive: {} as never,
  };

  const client = buildRealSheetsWriteClient(() => fakeClients);
  await client.getTechnicalIdColumn('sheet-1');
  await client.updateVisibleRow('sheet-1', 2, SAMPLE_ROW.slice(1));
  await client.appendFullRow('sheet-1', SAMPLE_ROW);

  // No GOOGLE_SHEETS_API_TIMEOUT_MS is set in this test process's env, so
  // getConfiguredApiTimeoutMs() falls back to env.schema.ts's own 30000ms
  // default — proving the real, unmocked config path, not a test double.
  assert.equal(seenTimeouts['values.get'], 30_000);
  assert.equal(seenTimeouts['values.update'], 30_000);
  assert.equal(seenTimeouts['values.append'], 30_000);
});
