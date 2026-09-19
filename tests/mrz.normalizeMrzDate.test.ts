import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeMrzDate } from '../src/ocr/mrz/normalizeMrzDate.js';

const REFERENCE_NOW = new Date('2026-06-15T00:00:00Z');

test('normalizeMrzDate converts a birth date to YYYY-MM-DD, resolving the century so it is never in the future', () => {
  assert.equal(normalizeMrzDate('740812', 'birth', REFERENCE_NOW), '1974-08-12');
  // A birth year of "10" read as 2010 is not in the future relative to 2026, so it stays 2010.
  assert.equal(normalizeMrzDate('100101', 'birth', REFERENCE_NOW), '2010-01-01');
  // A birth year of "30" as 2030 would be in the future — must resolve to 1930.
  assert.equal(normalizeMrzDate('300101', 'birth', REFERENCE_NOW), '1930-01-01');
});

test('normalizeMrzDate converts an expiry date to YYYY-MM-DD, preferring the reading close to now', () => {
  assert.equal(normalizeMrzDate('300101', 'expiry', REFERENCE_NOW), '2030-01-01');
  assert.equal(normalizeMrzDate('280615', 'expiry', REFERENCE_NOW), '2028-06-15');
  // "05" read as 2005 would be 21 years in the past for a travel document — resolves to 2105 instead.
  assert.equal(normalizeMrzDate('050101', 'expiry', REFERENCE_NOW), '2105-01-01');
});

test('normalizeMrzDate returns null for malformed input instead of guessing', () => {
  assert.equal(normalizeMrzDate(null, 'birth', REFERENCE_NOW), null);
  assert.equal(normalizeMrzDate(undefined, 'birth', REFERENCE_NOW), null);
  assert.equal(normalizeMrzDate('', 'birth', REFERENCE_NOW), null);
  assert.equal(normalizeMrzDate('12345', 'birth', REFERENCE_NOW), null); // 5 digits
  assert.equal(normalizeMrzDate('1234567', 'birth', REFERENCE_NOW), null); // 7 digits
  assert.equal(normalizeMrzDate('74AB12', 'birth', REFERENCE_NOW), null); // non-numeric
});

test('normalizeMrzDate returns null for a well-formed but impossible calendar date', () => {
  assert.equal(normalizeMrzDate('740230', 'birth', REFERENCE_NOW), null); // Feb 30 doesn't exist
  assert.equal(normalizeMrzDate('741399', 'birth', REFERENCE_NOW), null); // month 13
});
