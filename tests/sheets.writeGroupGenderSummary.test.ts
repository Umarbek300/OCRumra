import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeGroupGenderSummary, type GenderSummaryWriteClient } from '../src/sheets/writeGroupGenderSummary.js';
import { GENDER_SUMMARY_RANGE } from '../src/sheets/genderSummaryLayout.js';

test('writeGroupGenderSummary calls the client with the fixed O1:P5 range and the given rows', async () => {
  const calls: Array<{ spreadsheetId: string; range: string; values: readonly (readonly string[])[] }> = [];
  const fakeClient: GenderSummaryWriteClient = {
    async updateRange(spreadsheetId, range, values) {
      calls.push({ spreadsheetId, range, values });
    },
  };

  const rows = [
    ['Guruh: 20 September — 2026-09-20', ''],
    ['Jami:', '50'],
    ['Erkak:', '28'],
    ['Ayol:', '22'],
    ["Noma'lum:", '0'],
  ];
  await writeGroupGenderSummary('sheet-abc', rows, fakeClient);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.spreadsheetId, 'sheet-abc');
  assert.equal(calls[0]!.range, GENDER_SUMMARY_RANGE);
  assert.deepEqual(calls[0]!.values, rows);
});

test('writeGroupGenderSummary propagates a write failure to the caller (no swallowing)', async () => {
  const fakeClient: GenderSummaryWriteClient = {
    async updateRange() {
      throw new Error('Google Sheets API error: quota exceeded');
    },
  };

  await assert.rejects(() => writeGroupGenderSummary('sheet-abc', [['Jami:', '0']], fakeClient), /quota exceeded/);
});
