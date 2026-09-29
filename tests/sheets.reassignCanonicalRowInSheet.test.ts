import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reassignCanonicalRow, type ReassignCanonicalRowInput } from '../src/sheets/reassignCanonicalRowInSheet.js';
import type { ResolveSheetTitleByGid, SheetsWriteClient } from '../src/sheets/upsertRowInSheet.js';

const SAMPLE_ROW = ['', 'ANNA', 'ERIKSSON', 'L898902C3', '1974-08-12', '2004-01-01', '2012-04-15', 'Ayol', 'Jasur Agent', '', '', ''];

/** Full 13-element A:M row with the given technical id (column M, index 12). */
function realRow(technicalId: string): string[] {
  return ['1', 'ANNA', 'ERIKSSON', 'L898902C3', '1974-08-12', '2004-01-01', '2012-04-15', 'Ayol', 'Jasur Agent', '', '', '', technicalId];
}

interface Calls {
  getAllDataRows: number;
  updateVisibleRow: number;
}

function buildFakeClient(rows: string[][]): {
  client: SheetsWriteClient;
  calls: Calls;
  getAllDataRowsArgs: { spreadsheetId: string; sheetTitle?: string }[];
  updateArgs: { spreadsheetId: string; rowNumber: number; valuesFromColumnB: readonly string[]; sheetTitle?: string }[];
} {
  const calls: Calls = { getAllDataRows: 0, updateVisibleRow: 0 };
  const getAllDataRowsArgs: { spreadsheetId: string; sheetTitle?: string }[] = [];
  const updateArgs: { spreadsheetId: string; rowNumber: number; valuesFromColumnB: readonly string[]; sheetTitle?: string }[] = [];

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
    async writeRowAt() {
      throw new Error('writeRowAt should never be called by reassignCanonicalRow');
    },
  };

  return { client, calls, getAllDataRowsArgs, updateArgs };
}

function baseInput(overrides: Partial<ReassignCanonicalRowInput> = {}): ReassignCanonicalRowInput {
  return {
    spreadsheetId: 'sheet-1',
    oldCanonicalTelegramMessageId: 'old-msg',
    newCanonicalTelegramMessageId: 'new-msg',
    row: SAMPLE_ROW,
    ...overrides,
  };
}

// --- A. LEGACY: googleSheetGid absent/null behaves exactly as before ---

test('A.1: reassignCanonicalRow finds the old row and updates it, leaving № untouched (pre-existing behavior)', async () => {
  const { client, updateArgs } = buildFakeClient([realRow('other'), realRow('old-msg'), realRow('yet-another')]);

  const result = await reassignCanonicalRow(baseInput(), client);

  assert.deepEqual(result, { outcome: 'reassigned', rowNumber: 3 });
  assert.equal(updateArgs[0]!.rowNumber, 3);
  assert.equal(updateArgs[0]!.valuesFromColumnB[updateArgs[0]!.valuesFromColumnB.length - 1], 'new-msg');
});

test('A.2: not_found when the old canonical id is not present, and no write is attempted', async () => {
  const { client, calls } = buildFakeClient([realRow('some-other-msg')]);

  const result = await reassignCanonicalRow(baseInput({ oldCanonicalTelegramMessageId: 'missing' }), client);

  assert.deepEqual(result, { outcome: 'not_found' });
  assert.equal(calls.updateVisibleRow, 0);
});

test('A.3: googleSheetGid absent never resolves a title -- targets the default/first sheet (sheetTitle undefined throughout)', async () => {
  const { client, getAllDataRowsArgs, updateArgs } = buildFakeClient([realRow('old-msg')]);
  let resolveCalls = 0;
  const resolveSheetTitle: ResolveSheetTitleByGid = async () => {
    resolveCalls += 1;
    return 'should never be called';
  };

  await reassignCanonicalRow(baseInput(), client, resolveSheetTitle);

  assert.equal(resolveCalls, 0, 'a legacy call (no googleSheetGid) never resolves a tab title');
  assert.equal(getAllDataRowsArgs[0]!.sheetTitle, undefined);
  assert.equal(updateArgs[0]!.sheetTitle, undefined);
});

test('A.3b: googleSheetGid explicitly null behaves identically to it being omitted', async () => {
  const { client, getAllDataRowsArgs } = buildFakeClient([realRow('old-msg')]);
  let resolveCalls = 0;
  const resolveSheetTitle: ResolveSheetTitleByGid = async () => {
    resolveCalls += 1;
    return 'should never be called';
  };

  await reassignCanonicalRow(baseInput({ googleSheetGid: null }), client, resolveSheetTitle);

  assert.equal(resolveCalls, 0);
  assert.equal(getAllDataRowsArgs[0]!.sheetTitle, undefined);
});

// --- B. MASTER/TAB ---

test('B.1: googleSheetGid set resolves the live title via the gid and threads it into both the read and the write (never sheets[0])', async () => {
  const { client, getAllDataRowsArgs, updateArgs } = buildFakeClient([realRow('old-msg')]);
  const resolveSheetTitle: ResolveSheetTitleByGid = async (spreadsheetId, gid) => {
    assert.equal(spreadsheetId, 'master-abc');
    assert.equal(gid, 918273645);
    return '20 September 2026';
  };

  await reassignCanonicalRow(baseInput({ spreadsheetId: 'master-abc', googleSheetGid: 918273645 }), client, resolveSheetTitle);

  assert.equal(getAllDataRowsArgs[0]!.sheetTitle, '20 September 2026');
  assert.equal(updateArgs[0]!.sheetTitle, '20 September 2026');
});

test('B.2: a tab title with a space and one with an apostrophe are both passed through unmodified for sheetLayout to escape', async () => {
  for (const title of ['20 September 2026', "Bob's Group"]) {
    const { client, updateArgs } = buildFakeClient([realRow('old-msg')]);
    const resolveSheetTitle: ResolveSheetTitleByGid = async () => title;

    await reassignCanonicalRow(baseInput({ spreadsheetId: 'master-abc', googleSheetGid: 111 }), client, resolveSheetTitle);

    assert.equal(updateArgs[0]!.sheetTitle, title);
  }
});

test('B.3: no tab with the given gid throws a clear error and never touches the sheet at all', async () => {
  const { client, calls } = buildFakeClient([realRow('old-msg')]);
  const resolveSheetTitle: ResolveSheetTitleByGid = async () => {
    throw new Error('upsertRowInSheet: no tab with sheetId (gid) 999 was found in spreadsheet master-abc');
  };

  await assert.rejects(
    () => reassignCanonicalRow(baseInput({ spreadsheetId: 'master-abc', googleSheetGid: 999 }), client, resolveSheetTitle),
    /no tab with sheetId \(gid\) 999/,
  );
  assert.equal(calls.getAllDataRows, 0);
  assert.equal(calls.updateVisibleRow, 0);
});

test('B.4: a spreadsheets.get failure during title resolution prevents the reassign write from proceeding', async () => {
  const { client, calls } = buildFakeClient([realRow('old-msg')]);
  const resolveSheetTitle: ResolveSheetTitleByGid = async () => {
    throw new Error('spreadsheets.get failed: simulated API error');
  };

  await assert.rejects(
    () => reassignCanonicalRow(baseInput({ spreadsheetId: 'master-abc', googleSheetGid: 111 }), client, resolveSheetTitle),
    /simulated API error/,
  );
  assert.equal(calls.getAllDataRows, 0);
  assert.equal(calls.updateVisibleRow, 0);
});
