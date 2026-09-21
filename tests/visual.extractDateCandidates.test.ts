import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractDateCandidates } from '../src/ocr/visual/extractDateCandidates.js';

test('extractDateCandidates recognizes "DD MMM YYYY" textual-month dates', () => {
  assert.deepEqual(extractDateCandidates('DATE OF ISSUE 15 JAN 2020'), ['2020-01-15']);
});

test('extractDateCandidates recognizes "DD MMM YYYY" with no spaces', () => {
  assert.deepEqual(extractDateCandidates('15JAN2020'), ['2020-01-15']);
});

test('extractDateCandidates recognizes DD.MM.YYYY / DD/MM/YYYY / DD-MM-YYYY numeric formats', () => {
  assert.deepEqual(extractDateCandidates('15.01.2020'), ['2020-01-15']);
  assert.deepEqual(extractDateCandidates('15/01/2020'), ['2020-01-15']);
  assert.deepEqual(extractDateCandidates('15-01-2020'), ['2020-01-15']);
});

test('extractDateCandidates recognizes ISO-style YYYY-MM-DD', () => {
  assert.deepEqual(extractDateCandidates('2020-01-15'), ['2020-01-15']);
});

test('extractDateCandidates finds multiple distinct dates in one block of text', () => {
  const text = 'BIRTH 12 MAY 1990 ISSUE 15 JAN 2020 EXPIRY 15 JAN 2030';
  const result = extractDateCandidates(text);
  assert.deepEqual([...result].sort(), ['1990-05-12', '2020-01-15', '2030-01-15']);
});

test('extractDateCandidates deduplicates repeated matches', () => {
  assert.deepEqual(extractDateCandidates('15 JAN 2020 ... 15 JAN 2020'), ['2020-01-15']);
});

test('extractDateCandidates rejects an impossible calendar date (never invents/repairs it)', () => {
  assert.deepEqual(extractDateCandidates('32.13.2020'), []);
  assert.deepEqual(extractDateCandidates('30 FEB 2020'), []);
});

test('extractDateCandidates returns an empty array for text with no dates', () => {
  assert.deepEqual(extractDateCandidates('NO DATES HERE AT ALL'), []);
  assert.deepEqual(extractDateCandidates(''), []);
});

test('extractDateCandidates ignores an out-of-range year (guards against stray digit runs)', () => {
  assert.deepEqual(extractDateCandidates('15.01.1850'), []);
  assert.deepEqual(extractDateCandidates('15.01.2150'), []);
});
