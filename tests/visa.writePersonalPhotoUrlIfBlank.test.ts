import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VISA_PERSONAL_PHOTO_URL_COLUMN, VISA_PERSONAL_PORTRAIT_URL_COLUMN } from '../src/visa/visaSheetColumns.js';
import { writePersonalPhotoUrlIfBlank, type PhotoUrlCellClient } from '../src/visa/writePersonalPhotoUrlIfBlank.js';

function buildFakeClient(currentValue: string): {
  client: PhotoUrlCellClient;
  calls: { get: number; set: number };
  setArgs: unknown[];
} {
  const calls = { get: 0, set: 0 };
  const setArgs: unknown[] = [];
  const client: PhotoUrlCellClient = {
    async getCell() {
      calls.get += 1;
      return currentValue;
    },
    async setCell(spreadsheetId, column, rowNumber, value, sheetTitle) {
      calls.set += 1;
      setArgs.push({ spreadsheetId, column, rowNumber, value, sheetTitle });
    },
  };
  return { client, calls, setArgs };
}

test('writePersonalPhotoUrlIfBlank writes the URL when the cell is currently blank', async () => {
  const { client, calls, setArgs } = buildFakeClient('');

  const result = await writePersonalPhotoUrlIfBlank(
    'sheet-1',
    5,
    'https://visa.mahbubtour.uz/visa-photos/msg-1',
    VISA_PERSONAL_PHOTO_URL_COLUMN,
    undefined,
    client,
  );

  assert.equal(result, 'written');
  assert.equal(calls.get, 1);
  assert.equal(calls.set, 1);
  assert.deepEqual(setArgs[0], {
    spreadsheetId: 'sheet-1',
    column: 'T',
    rowNumber: 5,
    value: 'https://visa.mahbubtour.uz/visa-photos/msg-1',
    sheetTitle: undefined,
  });
});

test('writePersonalPhotoUrlIfBlank treats a whitespace-only cell as blank', async () => {
  const { client, calls } = buildFakeClient('   ');

  const result = await writePersonalPhotoUrlIfBlank(
    'sheet-1',
    5,
    'https://visa.mahbubtour.uz/visa-photos/msg-1',
    VISA_PERSONAL_PHOTO_URL_COLUMN,
    undefined,
    client,
  );

  assert.equal(result, 'written');
  assert.equal(calls.set, 1);
});

test('writePersonalPhotoUrlIfBlank NEVER overwrites an existing operator-entered value', async () => {
  const { client, calls } = buildFakeClient('https://example.com/manually-pasted-photo.jpg');

  const result = await writePersonalPhotoUrlIfBlank(
    'sheet-1',
    5,
    'https://visa.mahbubtour.uz/visa-photos/msg-1',
    VISA_PERSONAL_PHOTO_URL_COLUMN,
    undefined,
    client,
  );

  assert.equal(result, 'skipped-not-blank');
  assert.equal(calls.get, 1);
  assert.equal(calls.set, 0, 'must never call setCell when the column already has a value');
});

test('writePersonalPhotoUrlIfBlank passes the sheetTitle through for a master/tab group', async () => {
  const { client, setArgs } = buildFakeClient('');

  await writePersonalPhotoUrlIfBlank(
    'sheet-1',
    5,
    'https://visa.mahbubtour.uz/visa-photos/msg-1',
    VISA_PERSONAL_PHOTO_URL_COLUMN,
    'Live Tab Title',
    client,
  );

  assert.equal((setArgs[0] as { sheetTitle: string }).sheetTitle, 'Live Tab Title');
});

test('writePersonalPhotoUrlIfBlank propagates a real Sheets API failure to its caller', async () => {
  const client: PhotoUrlCellClient = {
    getCell: async () => {
      throw new Error('Google Sheets API error: quota exceeded');
    },
    setCell: async () => {},
  };

  await assert.rejects(
    () =>
      writePersonalPhotoUrlIfBlank(
        'sheet-1',
        5,
        'https://visa.mahbubtour.uz/visa-photos/msg-1',
        VISA_PERSONAL_PHOTO_URL_COLUMN,
        undefined,
        client,
      ),
    /quota exceeded/,
  );
});

test('writePersonalPhotoUrlIfBlank writes to the given column — the portrait column, independent from the photo column', async () => {
  const { client, setArgs } = buildFakeClient('');

  await writePersonalPhotoUrlIfBlank(
    'sheet-1',
    5,
    'https://visa.mahbubtour.uz/visa-photos/portrait-token',
    VISA_PERSONAL_PORTRAIT_URL_COLUMN,
    undefined,
    client,
  );

  assert.equal((setArgs[0] as { column: string }).column, 'V');
});
