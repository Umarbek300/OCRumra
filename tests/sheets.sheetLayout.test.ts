import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  columnBAndAfterRangeForRow,
  escapeSheetTitleForA1,
  FULL_ROW_RANGE_COLUMNS,
  fullRowRange,
  fullRowRangeColumns,
  HEADER_RANGE_A1,
  headerRangeA1,
  visibleDataRangeForRow,
  withSheetTitle,
} from '../src/sheets/sheetLayout.js';

// --- escapeSheetTitleForA1 ---

test('escapeSheetTitleForA1 wraps a plain title in single quotes', () => {
  assert.equal(escapeSheetTitleForA1('20 September 2026'), "'20 September 2026'");
});

test('escapeSheetTitleForA1 doubles a single apostrophe inside the title', () => {
  assert.equal(escapeSheetTitleForA1("Bob's Group"), "'Bob''s Group'");
});

test('escapeSheetTitleForA1 doubles every apostrophe when a title has more than one', () => {
  assert.equal(escapeSheetTitleForA1("O'Brien's O'Group"), "'O''Brien''s O''Group'");
});

test('escapeSheetTitleForA1 leaves a title with no special characters unchanged apart from the wrapping quotes', () => {
  assert.equal(escapeSheetTitleForA1('PlainTitle'), "'PlainTitle'");
});

// --- withSheetTitle ---

test('withSheetTitle returns the bare range unchanged when sheetTitle is omitted (legacy, one-file-per-group behavior)', () => {
  assert.equal(withSheetTitle('A2:M'), 'A2:M');
});

test('withSheetTitle prefixes the range with the escaped title when sheetTitle is given', () => {
  assert.equal(withSheetTitle('A2:M', '20 September 2026'), "'20 September 2026'!A2:M");
});

test('withSheetTitle escapes an apostrophe in the title before prefixing', () => {
  assert.equal(withSheetTitle('A2:M', "Bob's Group"), "'Bob''s Group'!A2:M");
});

// --- headerRangeA1 / fullRowRangeColumns (function forms of the fixed constants) ---

test('headerRangeA1 without a sheetTitle equals the bare HEADER_RANGE_A1 constant', () => {
  assert.equal(headerRangeA1(), HEADER_RANGE_A1);
});

test('headerRangeA1 with a sheetTitle prefixes HEADER_RANGE_A1', () => {
  assert.equal(headerRangeA1('20 September 2026'), `'20 September 2026'!${HEADER_RANGE_A1}`);
});

test('fullRowRangeColumns without a sheetTitle equals the bare FULL_ROW_RANGE_COLUMNS constant', () => {
  assert.equal(fullRowRangeColumns(), FULL_ROW_RANGE_COLUMNS);
});

test('fullRowRangeColumns with a sheetTitle prefixes FULL_ROW_RANGE_COLUMNS', () => {
  assert.equal(fullRowRangeColumns('20 September 2026'), `'20 September 2026'!${FULL_ROW_RANGE_COLUMNS}`);
});

// --- per-row range helpers ---

test('visibleDataRangeForRow without a sheetTitle targets A<row>:L<row>, unchanged legacy behavior', () => {
  assert.equal(visibleDataRangeForRow(5), 'A5:L5');
});

test('visibleDataRangeForRow with a sheetTitle prefixes the same A:L range', () => {
  assert.equal(visibleDataRangeForRow(5, "Bob's Group"), "'Bob''s Group'!A5:L5");
});

test('columnBAndAfterRangeForRow without a sheetTitle targets B<row>:M<row>, unchanged legacy behavior', () => {
  assert.equal(columnBAndAfterRangeForRow(5), 'B5:M5');
});

test('columnBAndAfterRangeForRow with a sheetTitle prefixes the same B:M range', () => {
  assert.equal(columnBAndAfterRangeForRow(5, '20 September 2026'), "'20 September 2026'!B5:M5");
});

test('fullRowRange without a sheetTitle targets A<row>:M<row>, unchanged legacy behavior', () => {
  assert.equal(fullRowRange(5), 'A5:M5');
});

test('fullRowRange with a sheetTitle prefixes the same A:M range', () => {
  assert.equal(fullRowRange(5, '20 September 2026'), "'20 September 2026'!A5:M5");
});
