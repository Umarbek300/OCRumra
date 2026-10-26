import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readVisaStatus, writeVisaStatus, VISA_STATUS_COLUMN, type VisaStatusCellClient } from '../src/visa/visitSaudiStatusCell.js';

const SPREADSHEET_ID = 'sheet-1';
const MSG_ID = 'msg-1';

function buildRow(telegramMessageIdAtColumnM: string | null): string[] {
  const row = new Array(23).fill('');
  if (telegramMessageIdAtColumnM !== null) {
    row[12] = telegramMessageIdAtColumnM;
  }
  return row;
}

// MSG_ID sits at index 2 -> expected rowNumber = FIRST_DATA_ROW_NUMBER(2) + 2 = 4.
const rowsWithMatch = [buildRow('other-1'), buildRow('other-2'), buildRow(MSG_ID)];
const EXPECTED_ROW_NUMBER = 4;

test('writes each of the three allowed statuses successfully', async () => {
  for (const status of ['PENDING', 'SAVED', 'ERROR'] as const) {
    const calls: Array<{ column: string; rowNumber: number; value: string }> = [];
    const client: VisaStatusCellClient = {
      getAllDataRows: async () => rowsWithMatch,
      getCell: async () => '',
      setCell: async (_spreadsheetId, column, rowNumber, value) => {
        calls.push({ column, rowNumber, value });
      },
    };

    const result = await writeVisaStatus(SPREADSHEET_ID, MSG_ID, status, undefined, client);

    assert.deepEqual(result, { ok: true, rowNumber: EXPECTED_ROW_NUMBER });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.column, VISA_STATUS_COLUMN);
    assert.equal(calls[0]!.rowNumber, EXPECTED_ROW_NUMBER);
    assert.equal(calls[0]!.value, status);
  }
});

test('rejects an invalid status value -- never calls setCell, never even looks up the row', async () => {
  let setCellCalled = false;
  let getAllDataRowsCalled = false;
  const client: VisaStatusCellClient = {
    getAllDataRows: async () => {
      getAllDataRowsCalled = true;
      return rowsWithMatch;
    },
    getCell: async () => '',
    setCell: async () => {
      setCellCalled = true;
    },
  };

  const result = await writeVisaStatus(SPREADSHEET_ID, MSG_ID, 'DONE', undefined, client);

  assert.deepEqual(result, { ok: false, reason: 'INVALID_STATUS_VALUE', detail: 'DONE' });
  assert.equal(setCellCalled, false);
  assert.equal(getAllDataRowsCalled, false);
});

test('updates an already-set status -- no blank-only guard (unlike writePersonalPhotoUrlIfBlank.ts, used only as a style reference)', async () => {
  const writtenValues: string[] = [];
  const client: VisaStatusCellClient = {
    getAllDataRows: async () => rowsWithMatch,
    getCell: async () => 'PENDING', // the cell already has a value
    setCell: async (_s, _c, _r, value) => {
      writtenValues.push(value);
    },
  };

  const result = await writeVisaStatus(SPREADSHEET_ID, MSG_ID, 'SAVED', undefined, client);

  assert.deepEqual(result, { ok: true, rowNumber: EXPECTED_ROW_NUMBER });
  assert.deepEqual(writtenValues, ['SAVED']); // overwritten, never skipped
});

test('a Sheets API error from setCell is returned as a result, never thrown', async () => {
  const client: VisaStatusCellClient = {
    getAllDataRows: async () => rowsWithMatch,
    getCell: async () => '',
    setCell: async () => {
      throw new Error('simulated Sheets API failure');
    },
  };

  const result = await writeVisaStatus(SPREADSHEET_ID, MSG_ID, 'SAVED', undefined, client);

  assert.deepEqual(result, { ok: false, reason: 'SHEETS_API_ERROR', detail: 'simulated Sheets API failure' });
});

test('a Sheets API error from getCell (read path) is returned as a result, never thrown', async () => {
  const client: VisaStatusCellClient = {
    getAllDataRows: async () => rowsWithMatch,
    getCell: async () => {
      throw new Error('simulated Sheets API failure');
    },
    setCell: async () => undefined,
  };

  const result = await readVisaStatus(SPREADSHEET_ID, MSG_ID, undefined, client);

  assert.deepEqual(result, { ok: false, reason: 'SHEETS_API_ERROR', detail: 'simulated Sheets API failure' });
});

test('applicant row not found (no matching technical ID anywhere) is handled safely for both read and write', async () => {
  const client: VisaStatusCellClient = {
    getAllDataRows: async () => [buildRow('unrelated-1'), buildRow('unrelated-2')],
    getCell: async () => '',
    setCell: async () => undefined,
  };

  const writeResult = await writeVisaStatus(SPREADSHEET_ID, MSG_ID, 'SAVED', undefined, client);
  assert.deepEqual(writeResult, { ok: false, reason: 'ROW_NOT_FOUND' });

  const readResult = await readVisaStatus(SPREADSHEET_ID, MSG_ID, undefined, client);
  assert.deepEqual(readResult, { ok: false, reason: 'ROW_NOT_FOUND' });
});

test('an invalid value already sitting in the cell is reported, never silently accepted as a real status', async () => {
  const client: VisaStatusCellClient = {
    getAllDataRows: async () => rowsWithMatch,
    getCell: async () => 'garbage-value',
    setCell: async () => undefined,
  };

  const result = await readVisaStatus(SPREADSHEET_ID, MSG_ID, undefined, client);
  assert.deepEqual(result, { ok: false, reason: 'INVALID_STORED_VALUE', detail: 'garbage-value' });
});

test('a blank cell reads as status: null, never guessed as a real status', async () => {
  const client: VisaStatusCellClient = {
    getAllDataRows: async () => rowsWithMatch,
    getCell: async () => '',
    setCell: async () => undefined,
  };

  const result = await readVisaStatus(SPREADSHEET_ID, MSG_ID, undefined, client);
  assert.deepEqual(result, { ok: true, status: null });
});

test('writing the status never touches any other column -- exactly ONE setCell call, to VISA_STATUS_COLUMN alone', async () => {
  const calls: Array<{ column: string; rowNumber: number }> = [];
  const client: VisaStatusCellClient = {
    getAllDataRows: async () => rowsWithMatch,
    getCell: async () => '',
    setCell: async (_s, column, rowNumber) => {
      calls.push({ column, rowNumber });
    },
  };

  await writeVisaStatus(SPREADSHEET_ID, MSG_ID, 'ERROR', undefined, client);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { column: VISA_STATUS_COLUMN, rowNumber: EXPECTED_ROW_NUMBER });
});
