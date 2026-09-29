import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deleteCanonicalRow, renumberFromFreshRead, type SheetsDeleteClient } from '../src/sheets/deleteRowInSheet.js';

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
} {
  const calls: Calls = { getAllDataRows: 0, getPrimarySheetId: 0, deleteRow: 0, renumberColumnA: 0 };
  const deleteArgs: unknown[] = [];
  const renumberArgs: unknown[] = [];

  // Mutable so deleteRow can simulate the sheet actually shrinking, letting
  // the subsequent renumber-from-fresh-read see the post-delete state, same
  // as the real Sheets API would.
  let currentRows = rows;

  const client: SheetsDeleteClient = {
    async getAllDataRows() {
      calls.getAllDataRows += 1;
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
    async renumberColumnA(spreadsheetId, rowsArg) {
      calls.renumberColumnA += 1;
      renumberArgs.push({ spreadsheetId, rows: rowsArg });
    },
  };

  return { client, calls, deleteArgs, renumberArgs };
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
