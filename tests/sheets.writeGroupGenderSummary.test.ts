import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeGroupGenderSummary, type GenderSummaryWriteClient } from '../src/sheets/writeGroupGenderSummary.js';
import { GENDER_SUMMARY_RANGE } from '../src/sheets/genderSummaryLayout.js';
import type { ResolveSheetTitleByGid } from '../src/sheets/upsertRowInSheet.js';

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
  await writeGroupGenderSummary('sheet-abc', rows, undefined, fakeClient);

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

  await assert.rejects(() => writeGroupGenderSummary('sheet-abc', [['Jami:', '0']], undefined, fakeClient), /quota exceeded/);
});

// --- A. LEGACY: googleSheetGid absent/null behaves exactly as before ---

test('A: googleSheetGid absent never resolves a title and writes the unprefixed GENDER_SUMMARY_RANGE', async () => {
  const calls: Array<{ range: string }> = [];
  const fakeClient: GenderSummaryWriteClient = {
    async updateRange(_spreadsheetId, range) {
      calls.push({ range });
    },
  };
  let resolveCalls = 0;
  const resolveSheetTitle: ResolveSheetTitleByGid = async () => {
    resolveCalls += 1;
    return 'should never be called';
  };

  await writeGroupGenderSummary('sheet-abc', [['Jami:', '0']], undefined, fakeClient, resolveSheetTitle);

  assert.equal(resolveCalls, 0, 'a legacy call (no googleSheetGid) never resolves a tab title');
  assert.equal(calls[0]!.range, GENDER_SUMMARY_RANGE);
});

test('A.b: googleSheetGid explicitly null behaves identically to it being omitted', async () => {
  const calls: Array<{ range: string }> = [];
  const fakeClient: GenderSummaryWriteClient = {
    async updateRange(_spreadsheetId, range) {
      calls.push({ range });
    },
  };
  const resolveSheetTitle: ResolveSheetTitleByGid = async () => {
    throw new Error('should never be called');
  };

  await writeGroupGenderSummary('sheet-abc', [['Jami:', '0']], null, fakeClient, resolveSheetTitle);

  assert.equal(calls[0]!.range, GENDER_SUMMARY_RANGE);
});

// --- B. MASTER/TAB ---

test('B: googleSheetGid set resolves the live title via spreadsheets.get(masterSpreadsheetId), never sheets[0], and prefixes the range', async () => {
  const calls: Array<{ spreadsheetId: string; range: string }> = [];
  const fakeClient: GenderSummaryWriteClient = {
    async updateRange(spreadsheetId, range) {
      calls.push({ spreadsheetId, range });
    },
  };
  const resolveSheetTitle: ResolveSheetTitleByGid = async (spreadsheetId, gid) => {
    assert.equal(spreadsheetId, 'master-abc');
    assert.equal(gid, 918273645);
    return '20 September 2026';
  };

  await writeGroupGenderSummary('master-abc', [['Jami:', '0']], 918273645, fakeClient, resolveSheetTitle);

  assert.equal(calls[0]!.spreadsheetId, 'master-abc');
  assert.equal(calls[0]!.range, "'20 September 2026'!O1:P5");
});

test('B.title-space-and-apostrophe: both a space and an apostrophe in the live title are correctly reflected/escaped in the final range', async () => {
  for (const [title, expectedRange] of [
    ['20 September 2026', "'20 September 2026'!O1:P5"],
    ["Bob's Group", "'Bob''s Group'!O1:P5"],
  ] as const) {
    const calls: Array<{ range: string }> = [];
    const fakeClient: GenderSummaryWriteClient = {
      async updateRange(_spreadsheetId, range) {
        calls.push({ range });
      },
    };
    const resolveSheetTitle: ResolveSheetTitleByGid = async () => title;

    await writeGroupGenderSummary('master-abc', [['Jami:', '0']], 111, fakeClient, resolveSheetTitle);

    assert.equal(calls[0]!.range, expectedRange);
  }
});

test('B.rename: a tab rename between calls is reflected -- the newly-resolved live title is used, never a stale one', async () => {
  const calls: Array<{ range: string }> = [];
  const fakeClient: GenderSummaryWriteClient = {
    async updateRange(_spreadsheetId, range) {
      calls.push({ range });
    },
  };
  let currentTitle = 'Old Title';
  const resolveSheetTitle: ResolveSheetTitleByGid = async () => currentTitle;

  await writeGroupGenderSummary('master-abc', [['Jami:', '0']], 111, fakeClient, resolveSheetTitle);
  currentTitle = 'Renamed Title';
  await writeGroupGenderSummary('master-abc', [['Jami:', '0']], 111, fakeClient, resolveSheetTitle);

  assert.equal(calls[0]!.range, "'Old Title'!O1:P5");
  assert.equal(calls[1]!.range, "'Renamed Title'!O1:P5");
});

test('B.not-found: no tab with the given gid throws a clear error and never calls the sheets client at all', async () => {
  let updateCalls = 0;
  const fakeClient: GenderSummaryWriteClient = {
    async updateRange() {
      updateCalls += 1;
    },
  };
  const resolveSheetTitle: ResolveSheetTitleByGid = async () => {
    throw new Error('upsertRowInSheet: no tab with sheetId (gid) 999 was found in spreadsheet master-abc');
  };

  await assert.rejects(
    () => writeGroupGenderSummary('master-abc', [['Jami:', '0']], 999, fakeClient, resolveSheetTitle),
    /no tab with sheetId \(gid\) 999/,
  );
  assert.equal(updateCalls, 0, 'the sheet is never written to once title resolution fails');
});

test('B.api-error: a spreadsheets.get failure during title resolution prevents the summary write from proceeding', async () => {
  let updateCalls = 0;
  const fakeClient: GenderSummaryWriteClient = {
    async updateRange() {
      updateCalls += 1;
    },
  };
  const resolveSheetTitle: ResolveSheetTitleByGid = async () => {
    throw new Error('spreadsheets.get failed: simulated API error');
  };

  await assert.rejects(
    () => writeGroupGenderSummary('master-abc', [['Jami:', '0']], 111, fakeClient, resolveSheetTitle),
    /simulated API error/,
  );
  assert.equal(updateCalls, 0);
});
