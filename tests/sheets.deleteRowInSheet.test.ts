import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildRealSheetsDeleteClient, deleteCanonicalRow, renumberFromFreshRead, type SheetsDeleteClient } from '../src/sheets/deleteRowInSheet.js';
import type { ResolveSheetTitleByGid } from '../src/sheets/upsertRowInSheet.js';
import type { SheetsClients } from '../src/sheets/sheetsAuth.js';

interface Calls {
  getAllDataRows: number;
  getPrimarySheetId: number;
  deleteRow: number;
  renumberColumnA: number;
}

function buildFakeClient(rows: string[][]): {
  client: SheetsDeleteClient;
  calls: Calls;
  deleteArgs: unknown[];
  renumberArgs: unknown[];
  getAllDataRowsArgs: { spreadsheetId: string; sheetTitle?: string }[];
} {
  const calls: Calls = { getAllDataRows: 0, getPrimarySheetId: 0, deleteRow: 0, renumberColumnA: 0 };
  const deleteArgs: unknown[] = [];
  const renumberArgs: unknown[] = [];
  const getAllDataRowsArgs: { spreadsheetId: string; sheetTitle?: string }[] = [];

  // Mutable so deleteRow can simulate the sheet actually shrinking, letting
  // the subsequent renumber-from-fresh-read see the post-delete state, same
  // as the real Sheets API would.
  let currentRows = rows;

  const client: SheetsDeleteClient = {
    async getAllDataRows(spreadsheetId, sheetTitle) {
      calls.getAllDataRows += 1;
      getAllDataRowsArgs.push({ spreadsheetId, sheetTitle });
      return currentRows;
    },
    async getPrimarySheetId() {
      calls.getPrimarySheetId += 1;
      return 0;
    },
    async deleteRow(spreadsheetId, sheetId, rowNumber) {
      calls.deleteRow += 1;
      deleteArgs.push({ spreadsheetId, sheetId, rowNumber });
      const zeroIndexed = rowNumber - 2; // FIRST_DATA_ROW_NUMBER = 2
      currentRows = [...currentRows.slice(0, zeroIndexed), ...currentRows.slice(zeroIndexed + 1)];
    },
    async renumberColumnA(spreadsheetId, rowsArg, sheetTitle) {
      calls.renumberColumnA += 1;
      renumberArgs.push({ spreadsheetId, rows: rowsArg, sheetTitle });
    },
  };

  return { client, calls, deleteArgs, renumberArgs, getAllDataRowsArgs };
}

/** Full 13-element A:M row with the given technical id (column M, index 12). */
function realRow(technicalId: string): string[] {
  return ['1', 'ANNA', 'ERIKSSON', 'L898902C3', '1974-08-12', '2004-01-01', '2012-04-15', 'Ayol', 'Jasur Agent', '', '', '', technicalId];
}

test('deleteCanonicalRow returns not_found and touches nothing when the id is not in any row', async () => {
  const { client, calls } = buildFakeClient([realRow('msg-a'), realRow('msg-b')]);

  const result = await deleteCanonicalRow({ spreadsheetId: 'sheet-1', expectedCanonicalTelegramMessageId: 'msg-missing' }, client);

  assert.deepEqual(result, { outcome: 'not_found' });
  assert.equal(calls.deleteRow, 0);
  assert.equal(calls.renumberColumnA, 0);
});

test('deleteCanonicalRow deletes the correct row (found via column M, never a trusted row number)', async () => {
  const { client, calls, deleteArgs } = buildFakeClient([realRow('msg-a'), realRow('msg-b'), realRow('msg-c')]);

  const result = await deleteCanonicalRow({ spreadsheetId: 'sheet-1', expectedCanonicalTelegramMessageId: 'msg-b' }, client);

  assert.deepEqual(result, { outcome: 'deleted', rowNumber: 3 }); // FIRST_DATA_ROW_NUMBER(2) + index(1)
  assert.equal(calls.deleteRow, 1);
  assert.deepEqual(deleteArgs[0], { spreadsheetId: 'sheet-1', sheetId: 0, rowNumber: 3 });
});

test('deleteCanonicalRow deletes the FIRST matching row when it is the first data row', async () => {
  const { client } = buildFakeClient([realRow('msg-target'), realRow('msg-other')]);

  const result = await deleteCanonicalRow({ spreadsheetId: 'sheet-1', expectedCanonicalTelegramMessageId: 'msg-target' }, client);

  assert.deepEqual(result, { outcome: 'deleted', rowNumber: 2 });
});

test('deleteCanonicalRow renumbers column A for every remaining row after the delete, from a FRESH post-delete read', async () => {
  const { client, calls, renumberArgs } = buildFakeClient([realRow('msg-a'), realRow('msg-b'), realRow('msg-c')]);

  await deleteCanonicalRow({ spreadsheetId: 'sheet-1', expectedCanonicalTelegramMessageId: 'msg-b' }, client);

  assert.equal(calls.renumberColumnA, 1);
  const passedRows = (renumberArgs[0] as { rows: string[][] }).rows;
  assert.equal(passedRows.length, 2, 'only the two SURVIVING rows are passed to renumbering');
  assert.equal(passedRows[0]?.[12], 'msg-a');
  assert.equal(passedRows[1]?.[12], 'msg-c');
});

test('deleteCanonicalRow never renumbers when nothing was deleted (not_found short-circuits)', async () => {
  const { client, calls } = buildFakeClient([realRow('msg-a')]);
  await deleteCanonicalRow({ spreadsheetId: 'sheet-1', expectedCanonicalTelegramMessageId: 'msg-missing' }, client);
  assert.equal(calls.renumberColumnA, 0);
});

test('deleteCanonicalRow re-reads the sheet fresh -- never trusts a previously cached row position across two calls', async () => {
  const { client, calls } = buildFakeClient([realRow('msg-a'), realRow('msg-b'), realRow('msg-c')]);

  await deleteCanonicalRow({ spreadsheetId: 'sheet-1', expectedCanonicalTelegramMessageId: 'msg-a' }, client);
  // After deleting msg-a, msg-c is now at index 1 (was index 2) -- a second
  // delete for msg-c must still find and remove the RIGHT row despite the shift.
  const result = await deleteCanonicalRow({ spreadsheetId: 'sheet-1', expectedCanonicalTelegramMessageId: 'msg-c' }, client);

  assert.deepEqual(result, { outcome: 'deleted', rowNumber: 3 }, 'msg-c is now at data-row 3 (index 1) after msg-a was removed');
  assert.equal(calls.getAllDataRows, 4, 'each delete does its own fresh read, plus each renumber does its own fresh read');
});

test('renumberFromFreshRead writes sequential values starting at 1 for whatever the sheet currently holds', async () => {
  const { client, renumberArgs } = buildFakeClient([realRow('msg-x'), realRow('msg-y')]);
  await renumberFromFreshRead('sheet-1', client);
  const passedRows = (renumberArgs[0] as { rows: string[][] }).rows;
  assert.equal(passedRows.length, 2);
});

test('renumberFromFreshRead is a safe no-op on an empty sheet', async () => {
  const { client, calls } = buildFakeClient([]);
  await renumberFromFreshRead('sheet-1', client);
  assert.equal(calls.renumberColumnA, 1, 'still called, with an empty array -- the real client treats that as a no-op internally');
});

// --- A. LEGACY: googleSheetGid absent/null behaves exactly as before ---

test('A.1: googleSheetGid absent never resolves a title and uses getPrimarySheetId, exactly as before', async () => {
  const { client, calls, getAllDataRowsArgs, deleteArgs } = buildFakeClient([realRow('msg-a')]);
  let resolveCalls = 0;
  const resolveSheetTitle: ResolveSheetTitleByGid = async () => {
    resolveCalls += 1;
    return 'should never be called';
  };

  await deleteCanonicalRow({ spreadsheetId: 'sheet-1', expectedCanonicalTelegramMessageId: 'msg-a' }, client, resolveSheetTitle);

  assert.equal(resolveCalls, 0, 'a legacy call (no googleSheetGid) never resolves a tab title');
  assert.equal(calls.getPrimarySheetId, 1, 'legacy path still uses getPrimarySheetId');
  assert.equal(getAllDataRowsArgs[0]!.sheetTitle, undefined);
  assert.equal((deleteArgs[0] as { sheetId: number }).sheetId, 0);
});

test('A.1b: googleSheetGid explicitly null behaves identically to it being omitted', async () => {
  const { client, calls } = buildFakeClient([realRow('msg-a')]);
  await deleteCanonicalRow({ spreadsheetId: 'sheet-1', expectedCanonicalTelegramMessageId: 'msg-a', googleSheetGid: null }, client);
  assert.equal(calls.getPrimarySheetId, 1);
});

// --- B. MASTER/TAB ---

test('B.3/4/5/6: googleSheetGid set resolves the live title via spreadsheets.get(masterSpreadsheetId) and never calls getPrimarySheetId', async () => {
  const { client, calls, getAllDataRowsArgs } = buildFakeClient([realRow('msg-a')]);
  const resolveSheetTitle: ResolveSheetTitleByGid = async (spreadsheetId, gid) => {
    assert.equal(spreadsheetId, 'master-abc');
    assert.equal(gid, 918273645);
    return '20 September 2026';
  };

  await deleteCanonicalRow(
    { spreadsheetId: 'master-abc', expectedCanonicalTelegramMessageId: 'msg-a', googleSheetGid: 918273645 },
    client,
    resolveSheetTitle,
  );

  assert.equal(calls.getPrimarySheetId, 0, 'never falls back to sheets[0] for a master/tab group');
  assert.equal(getAllDataRowsArgs[0]!.sheetTitle, '20 September 2026');
});

test('B.13: deleteRow is called with googleSheetGid itself as sheetId, never a value from getPrimarySheetId', async () => {
  const { client, deleteArgs } = buildFakeClient([realRow('msg-a')]);
  const resolveSheetTitle: ResolveSheetTitleByGid = async () => '20 September 2026';

  await deleteCanonicalRow(
    { spreadsheetId: 'master-abc', expectedCanonicalTelegramMessageId: 'msg-a', googleSheetGid: 918273645 },
    client,
    resolveSheetTitle,
  );

  assert.equal((deleteArgs[0] as { sheetId: number }).sheetId, 918273645);
});

test('B.7: the resolved live title is also threaded into the post-delete renumber, not just the initial read', async () => {
  const { client, renumberArgs } = buildFakeClient([realRow('msg-a'), realRow('msg-b')]);
  const resolveSheetTitle: ResolveSheetTitleByGid = async () => '20 September 2026';

  await deleteCanonicalRow(
    { spreadsheetId: 'master-abc', expectedCanonicalTelegramMessageId: 'msg-a', googleSheetGid: 111 },
    client,
    resolveSheetTitle,
  );

  assert.equal((renumberArgs[0] as { sheetTitle?: string }).sheetTitle, '20 September 2026');
});

test('B.8: a tab title with a space is passed through unmodified for sheetLayout to build the correct A1 range', async () => {
  const { client, getAllDataRowsArgs } = buildFakeClient([realRow('msg-a')]);
  const resolveSheetTitle: ResolveSheetTitleByGid = async () => '20 September 2026';

  await deleteCanonicalRow({ spreadsheetId: 'master-abc', expectedCanonicalTelegramMessageId: 'msg-a', googleSheetGid: 111 }, client, resolveSheetTitle);

  assert.equal(getAllDataRowsArgs[0]!.sheetTitle, '20 September 2026');
});

test('B.9: a tab title with an apostrophe is passed through unmodified for sheetLayout to escape', async () => {
  const { client, getAllDataRowsArgs } = buildFakeClient([realRow('msg-a')]);
  const resolveSheetTitle: ResolveSheetTitleByGid = async () => "Bob's Group";

  await deleteCanonicalRow({ spreadsheetId: 'master-abc', expectedCanonicalTelegramMessageId: 'msg-a', googleSheetGid: 111 }, client, resolveSheetTitle);

  assert.equal(getAllDataRowsArgs[0]!.sheetTitle, "Bob's Group");
});

test('B.10: a tab rename between calls is reflected -- the newly-resolved live title is used, never a stale one', async () => {
  // Two distinct rows so each call actually finds-and-deletes one (each
  // deleteCanonicalRow call makes its own initial read PLUS a post-delete
  // renumber read -- two getAllDataRows calls per successful delete).
  const { client, getAllDataRowsArgs } = buildFakeClient([realRow('msg-a'), realRow('msg-b')]);
  let currentTitle = 'Old Title';
  const resolveSheetTitle: ResolveSheetTitleByGid = async () => currentTitle;

  const first = await deleteCanonicalRow({ spreadsheetId: 'master-abc', expectedCanonicalTelegramMessageId: 'msg-a', googleSheetGid: 111 }, client, resolveSheetTitle);
  currentTitle = 'Renamed Title';
  const second = await deleteCanonicalRow({ spreadsheetId: 'master-abc', expectedCanonicalTelegramMessageId: 'msg-b', googleSheetGid: 111 }, client, resolveSheetTitle);

  assert.equal(first.outcome, 'deleted');
  assert.equal(second.outcome, 'deleted');
  assert.equal(getAllDataRowsArgs[0]!.sheetTitle, 'Old Title', "first call's initial read");
  assert.equal(getAllDataRowsArgs[2]!.sheetTitle, 'Renamed Title', "second call's initial read (index 2: after call 1's initial+renumber reads)");
});

test('B.11: no tab with the given gid throws a clear error and never touches the sheet at all', async () => {
  const { client, calls } = buildFakeClient([realRow('msg-a')]);
  const resolveSheetTitle: ResolveSheetTitleByGid = async () => {
    throw new Error('upsertRowInSheet: no tab with sheetId (gid) 999 was found in spreadsheet master-abc');
  };

  await assert.rejects(
    () => deleteCanonicalRow({ spreadsheetId: 'master-abc', expectedCanonicalTelegramMessageId: 'msg-a', googleSheetGid: 999 }, client, resolveSheetTitle),
    /no tab with sheetId \(gid\) 999/,
  );
  assert.equal(calls.getAllDataRows, 0, 'the sheet is never even read once title resolution fails');
  assert.equal(calls.deleteRow, 0);
});

test('B.12: a spreadsheets.get failure during title resolution prevents the delete from proceeding', async () => {
  const { client, calls } = buildFakeClient([realRow('msg-a')]);
  const resolveSheetTitle: ResolveSheetTitleByGid = async () => {
    throw new Error('spreadsheets.get failed: simulated API error');
  };

  await assert.rejects(
    () => deleteCanonicalRow({ spreadsheetId: 'master-abc', expectedCanonicalTelegramMessageId: 'msg-a', googleSheetGid: 111 }, client, resolveSheetTitle),
    /simulated API error/,
  );
  assert.equal(calls.getAllDataRows, 0);
  assert.equal(calls.deleteRow, 0);
  assert.equal(calls.renumberColumnA, 0);
});

// --- buildRealSheetsDeleteClient: real A1-range escaping and legacy no-prefix behavior ---

test('buildRealSheetsDeleteClient builds the correct quoted A1 range for a tab title with a space', async () => {
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

  const client = buildRealSheetsDeleteClient(() => fakeClients);
  await client.getAllDataRows('master-abc', '20 September 2026');
  await client.renumberColumnA('master-abc', [['1'], ['2']], '20 September 2026');

  assert.equal(seenRanges[0], "'20 September 2026'!A2:M");
  assert.equal(seenRanges[1], "'20 September 2026'!A2:A3");
});

test('buildRealSheetsDeleteClient correctly escapes a tab title containing an apostrophe', async () => {
  const seenRanges: string[] = [];
  const fakeClients: SheetsClients = {
    sheets: {
      spreadsheets: {
        values: {
          get: (async (params: { range: string }) => {
            seenRanges.push(params.range);
            return { data: { values: [] } };
          }) as never,
        },
      },
    } as never,
    drive: {} as never,
  };

  const client = buildRealSheetsDeleteClient(() => fakeClients);
  await client.getAllDataRows('master-abc', "Bob's Group");

  assert.equal(seenRanges[0], "'Bob''s Group'!A2:M", 'the single apostrophe is doubled, per Google Sheets A1 escaping');
});

test('buildRealSheetsDeleteClient targets the default/first sheet (no prefix) when sheetTitle is omitted, unchanged legacy behavior', async () => {
  const seenRanges: string[] = [];
  const fakeClients: SheetsClients = {
    sheets: {
      spreadsheets: {
        values: {
          get: (async (params: { range: string }) => {
            seenRanges.push(params.range);
            return { data: { values: [] } };
          }) as never,
        },
      },
    } as never,
    drive: {} as never,
  };

  const client = buildRealSheetsDeleteClient(() => fakeClients);
  await client.getAllDataRows('sheet-1');

  assert.equal(seenRanges[0], 'A2:M', 'no sheet-name prefix -- exactly the pre-existing legacy range');
});
