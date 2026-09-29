import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildRealSheetsWriteClient,
  buildRealSheetTitleResolver,
  upsertRowInSheet,
  type ResolveSheetTitleByGid,
  type SheetsWriteClient,
} from '../src/sheets/upsertRowInSheet.js';
import type { SheetsClients } from '../src/sheets/sheetsAuth.js';

const SAMPLE_ROW = ['', 'ANNA', 'ERIKSSON', 'L898902C3', '1974-08-12', '2004-01-01', '2012-04-15', 'Ayol', 'Jasur Agent', '', '', ''];

interface Calls {
  getAllDataRows: number;
  updateVisibleRow: number;
  writeRowAt: number;
}

function buildFakeClient(rows: string[][]): {
  client: SheetsWriteClient;
  calls: Calls;
  updateArgs: unknown[];
  writeArgs: unknown[];
  getAllDataRowsArgs: { spreadsheetId: string; sheetTitle?: string }[];
} {
  const calls: Calls = { getAllDataRows: 0, updateVisibleRow: 0, writeRowAt: 0 };
  const updateArgs: unknown[] = [];
  const writeArgs: unknown[] = [];
  const getAllDataRowsArgs: { spreadsheetId: string; sheetTitle?: string }[] = [];

  const client: SheetsWriteClient = {
    async getAllDataRows(spreadsheetId, sheetTitle) {
      calls.getAllDataRows += 1;
      getAllDataRowsArgs.push({ spreadsheetId, sheetTitle });
      return rows;
    },
    async updateVisibleRow(spreadsheetId, rowNumber, valuesFromColumnB, sheetTitle) {
      calls.updateVisibleRow += 1;
      updateArgs.push({ spreadsheetId, rowNumber, valuesFromColumnB, sheetTitle });
    },
    async writeRowAt(spreadsheetId, rowNumber, fullValues, sheetTitle) {
      calls.writeRowAt += 1;
      writeArgs.push({ spreadsheetId, rowNumber, fullValues, sheetTitle });
    },
  };

  return { client, calls, updateArgs, writeArgs, getAllDataRowsArgs };
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

// --- A. LEGACY: googleSheetGid absent/null behaves exactly as before ---

test('A.1: googleSheetGid absent never resolves a title and targets the default/first sheet (sheetTitle undefined throughout)', async () => {
  const { client, getAllDataRowsArgs, writeArgs } = buildFakeClient([]);
  let resolveCalls = 0;
  const resolveSheetTitle: ResolveSheetTitleByGid = async () => {
    resolveCalls += 1;
    return 'should never be called';
  };

  await upsertRowInSheet({ spreadsheetId: 'sheet-1', telegramMessageId: 'msg-1', row: SAMPLE_ROW }, client, resolveSheetTitle);

  assert.equal(resolveCalls, 0, 'a legacy call (no googleSheetGid) never resolves a tab title');
  assert.equal(getAllDataRowsArgs[0]!.sheetTitle, undefined);
  assert.equal((writeArgs[0] as { sheetTitle?: string }).sheetTitle, undefined);
});

test('A.1b: googleSheetGid explicitly null behaves identically to it being omitted', async () => {
  const { client, getAllDataRowsArgs } = buildFakeClient([]);
  let resolveCalls = 0;
  const resolveSheetTitle: ResolveSheetTitleByGid = async () => {
    resolveCalls += 1;
    return 'should never be called';
  };

  await upsertRowInSheet({ spreadsheetId: 'sheet-1', telegramMessageId: 'msg-1', row: SAMPLE_ROW, googleSheetGid: null }, client, resolveSheetTitle);

  assert.equal(resolveCalls, 0);
  assert.equal(getAllDataRowsArgs[0]!.sheetTitle, undefined);
});

// --- B. MASTER/TAB ---

test('B.3/6/7: googleSheetGid set resolves the live title via the gid and threads it into every client call (never sheets[0])', async () => {
  const { client, getAllDataRowsArgs, writeArgs } = buildFakeClient([]);
  const resolveSheetTitle: ResolveSheetTitleByGid = async (spreadsheetId, gid) => {
    assert.equal(spreadsheetId, 'master-abc');
    assert.equal(gid, 918273645);
    return '20 September 2026';
  };

  await upsertRowInSheet(
    { spreadsheetId: 'master-abc', telegramMessageId: 'msg-1', row: SAMPLE_ROW, googleSheetGid: 918273645 },
    client,
    resolveSheetTitle,
  );

  assert.equal(getAllDataRowsArgs[0]!.sheetTitle, '20 September 2026');
  assert.equal((writeArgs[0] as { sheetTitle?: string }).sheetTitle, '20 September 2026');
});

test('B.13: an existing-row update (not just a new-row insert) is also routed to the resolved live tab title', async () => {
  const { client, updateArgs } = buildFakeClient([realRow('msg-123')]);
  const resolveSheetTitle: ResolveSheetTitleByGid = async () => '20 September 2026';

  await upsertRowInSheet(
    { spreadsheetId: 'master-abc', telegramMessageId: 'msg-123', row: SAMPLE_ROW, googleSheetGid: 111 },
    client,
    resolveSheetTitle,
  );

  assert.equal((updateArgs[0] as { sheetTitle?: string }).sheetTitle, '20 September 2026');
});

test('B.10: a tab rename between calls is reflected -- the newly-resolved live title is used, never a stale one', async () => {
  const { client, writeArgs } = buildFakeClient([]);
  let currentTitle = 'Old Title';
  const resolveSheetTitle: ResolveSheetTitleByGid = async () => currentTitle;

  await upsertRowInSheet({ spreadsheetId: 'master-abc', telegramMessageId: 'msg-a', row: SAMPLE_ROW, googleSheetGid: 111 }, client, resolveSheetTitle);
  currentTitle = 'Renamed Title'; // simulates a human renaming the tab between calls
  await upsertRowInSheet({ spreadsheetId: 'master-abc', telegramMessageId: 'msg-b', row: SAMPLE_ROW, googleSheetGid: 111 }, client, resolveSheetTitle);

  assert.equal((writeArgs[0] as { sheetTitle?: string }).sheetTitle, 'Old Title');
  assert.equal((writeArgs[1] as { sheetTitle?: string }).sheetTitle, 'Renamed Title');
});

test('B.8: a tab title containing a space produces the correct quoted A1 range prefix', async () => {
  const { client, writeArgs } = buildFakeClient([]);
  const resolveSheetTitle: ResolveSheetTitleByGid = async () => '20 September 2026';

  await upsertRowInSheet({ spreadsheetId: 'master-abc', telegramMessageId: 'msg-a', row: SAMPLE_ROW, googleSheetGid: 111 }, client, resolveSheetTitle);

  // buildRealSheetsWriteClient (exercised separately below) is what turns
  // sheetTitle into the actual quoted range via sheetLayout's own
  // withSheetTitle/fullRowRange -- this fake client only proves the raw
  // title reaches writeRowAt unmodified, which is what feeds that escaping.
  assert.equal((writeArgs[0] as { sheetTitle?: string }).sheetTitle, '20 September 2026');
});

test('B.9: a tab title containing an apostrophe is passed through unmodified for sheetLayout to escape', async () => {
  const { client, writeArgs } = buildFakeClient([]);
  const resolveSheetTitle: ResolveSheetTitleByGid = async () => "Bob's Group";

  await upsertRowInSheet({ spreadsheetId: 'master-abc', telegramMessageId: 'msg-a', row: SAMPLE_ROW, googleSheetGid: 111 }, client, resolveSheetTitle);

  assert.equal((writeArgs[0] as { sheetTitle?: string }).sheetTitle, "Bob's Group");
});

test('B.11: no tab with the given gid throws a clear error and never calls the sheets client at all', async () => {
  const { client, calls } = buildFakeClient([]);
  const resolveSheetTitle: ResolveSheetTitleByGid = async () => {
    throw new Error('upsertRowInSheet: no tab with sheetId (gid) 999 was found in spreadsheet master-abc');
  };

  await assert.rejects(
    () => upsertRowInSheet({ spreadsheetId: 'master-abc', telegramMessageId: 'msg-a', row: SAMPLE_ROW, googleSheetGid: 999 }, client, resolveSheetTitle),
    /no tab with sheetId \(gid\) 999/,
  );
  assert.equal(calls.getAllDataRows, 0, 'the sheet is never even read once title resolution fails');
  assert.equal(calls.writeRowAt, 0);
});

test('B.12: a spreadsheets.get failure during title resolution prevents any write', async () => {
  const { client, calls } = buildFakeClient([]);
  const resolveSheetTitle: ResolveSheetTitleByGid = async () => {
    throw new Error('spreadsheets.get failed: simulated API error');
  };

  await assert.rejects(
    () => upsertRowInSheet({ spreadsheetId: 'master-abc', telegramMessageId: 'msg-a', row: SAMPLE_ROW, googleSheetGid: 111 }, client, resolveSheetTitle),
    /simulated API error/,
  );
  assert.equal(calls.getAllDataRows, 0);
  assert.equal(calls.updateVisibleRow, 0);
  assert.equal(calls.writeRowAt, 0);
});

// --- buildRealSheetTitleResolver: real gid -> live title resolution, never sheets[0] ---

test('buildRealSheetTitleResolver calls spreadsheets.get with the exact spreadsheetId and requests only sheetId/title fields', async () => {
  const seenParams: { spreadsheetId?: string; fields?: string } = {};
  const fakeClients: SheetsClients = {
    sheets: {
      spreadsheets: {
        get: (async (params: { spreadsheetId: string; fields?: string }) => {
          seenParams.spreadsheetId = params.spreadsheetId;
          seenParams.fields = params.fields;
          return { data: { sheets: [{ properties: { sheetId: 111, title: 'Group A' } }] } };
        }) as never,
      },
    } as never,
    drive: {} as never,
  };

  const resolve = buildRealSheetTitleResolver(() => fakeClients);
  const title = await resolve('master-abc', 111);

  assert.equal(title, 'Group A');
  assert.equal(seenParams.spreadsheetId, 'master-abc');
  assert.match(seenParams.fields ?? '', /sheetId/);
  assert.match(seenParams.fields ?? '', /title/);
});

test('buildRealSheetTitleResolver picks the tab matching gid, never the first tab in the list', async () => {
  const fakeClients: SheetsClients = {
    sheets: {
      spreadsheets: {
        get: (async () => ({
          data: {
            sheets: [
              { properties: { sheetId: 1000, title: 'Some Other Group' } },
              { properties: { sheetId: 222, title: 'The Right Group' } },
              { properties: { sheetId: 3000, title: 'Yet Another Group' } },
            ],
          },
        })) as never,
      },
    } as never,
    drive: {} as never,
  };

  const resolve = buildRealSheetTitleResolver(() => fakeClients);
  const title = await resolve('master-abc', 222);

  assert.equal(title, 'The Right Group', 'must match by gid, not just take sheets[0]');
});

test('buildRealSheetTitleResolver throws a clear error when no sheet matches the gid', async () => {
  const fakeClients: SheetsClients = {
    sheets: {
      spreadsheets: {
        get: (async () => ({ data: { sheets: [{ properties: { sheetId: 1, title: 'Other' } }] } })) as never,
      },
    } as never,
    drive: {} as never,
  };

  const resolve = buildRealSheetTitleResolver(() => fakeClients);
  await assert.rejects(() => resolve('master-abc', 999), /no tab with sheetId \(gid\) 999 was found in spreadsheet master-abc/);
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

test('buildRealSheetsWriteClient builds the correct quoted A1 range for a tab title with a space', async () => {
  const seenRanges: string[] = [];
  const fakeClients: SheetsClients = {
    sheets: {
      spreadsheets: {
        values: {
          get: (async (params: { range: string }) => {
            seenRanges.push(params.range);
            return { data: { values: [] } };
          }) as never,
          update: (async (params: { range: string }) => {
            seenRanges.push(params.range);
            return { data: {} };
          }) as never,
        },
      },
    } as never,
    drive: {} as never,
  };

  const client = buildRealSheetsWriteClient(() => fakeClients);
  await client.getAllDataRows('master-abc', '20 September 2026');
  await client.writeRowAt('master-abc', 2, SAMPLE_ROW, '20 September 2026');
  await client.updateVisibleRow('master-abc', 2, SAMPLE_ROW.slice(1), '20 September 2026');

  assert.equal(seenRanges[0], "'20 September 2026'!A2:M");
  assert.equal(seenRanges[1], "'20 September 2026'!A2:M2");
  assert.equal(seenRanges[2], "'20 September 2026'!B2:M2");
});

test('buildRealSheetsWriteClient correctly escapes a tab title containing an apostrophe in the real A1 range', async () => {
  const seenRanges: string[] = [];
  const fakeClients: SheetsClients = {
    sheets: {
      spreadsheets: {
        values: {
          get: (async (params: { range: string }) => {
            seenRanges.push(params.range);
            return { data: { values: [] } };
          }) as never,
          update: (async (params: { range: string }) => {
            seenRanges.push(params.range);
            return { data: {} };
          }) as never,
        },
      },
    } as never,
    drive: {} as never,
  };

  const client = buildRealSheetsWriteClient(() => fakeClients);
  await client.writeRowAt('master-abc', 2, SAMPLE_ROW, "Bob's Group");

  assert.equal(seenRanges[0], "'Bob''s Group'!A2:M2", 'the single apostrophe is doubled, per Google Sheets A1 escaping');
});

test('buildRealSheetsWriteClient targets the default/first sheet (no prefix) when sheetTitle is omitted, unchanged legacy behavior', async () => {
  const seenRanges: string[] = [];
  const fakeClients: SheetsClients = {
    sheets: {
      spreadsheets: {
        values: {
          get: (async (params: { range: string }) => {
            seenRanges.push(params.range);
            return { data: { values: [] } };
          }) as never,
          update: (async (params: { range: string }) => {
            seenRanges.push(params.range);
            return { data: {} };
          }) as never,
        },
      },
    } as never,
    drive: {} as never,
  };

  const client = buildRealSheetsWriteClient(() => fakeClients);
  await client.getAllDataRows('sheet-1');
  await client.writeRowAt('sheet-1', 2, SAMPLE_ROW);

  assert.equal(seenRanges[0], 'A2:M', 'no sheet-name prefix -- exactly the pre-existing legacy range');
  assert.equal(seenRanges[1], 'A2:M2');
});
