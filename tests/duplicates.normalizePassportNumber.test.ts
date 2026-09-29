import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizePassportNumber } from '../src/duplicates/normalizePassportNumber.js';

test('normalizePassportNumber uppercases lowercase letters', () => {
  assert.equal(normalizePassportNumber('ab1234567'), 'AB1234567');
});

test('normalizePassportNumber strips internal whitespace', () => {
  assert.equal(normalizePassportNumber('AB 123 4567'), 'AB1234567');
});

test('normalizePassportNumber strips leading/trailing whitespace', () => {
  assert.equal(normalizePassportNumber('  AB1234567  '), 'AB1234567');
});

test('normalizePassportNumber does NOT strip leading zeros', () => {
  assert.equal(normalizePassportNumber('0012345'), '0012345');
});

test('normalizePassportNumber does NOT change digits/letters otherwise', () => {
  assert.equal(normalizePassportNumber('Fa998877'), 'FA998877');
});

test('normalizePassportNumber does NOT remove punctuation', () => {
  assert.equal(normalizePassportNumber('ab-1234567'), 'AB-1234567');
});

test('normalizePassportNumber does NOT substitute O for 0 or I for 1', () => {
  assert.equal(normalizePassportNumber('OI1234'), 'OI1234');
});

test('normalizePassportNumber is idempotent', () => {
  const once = normalizePassportNumber('ab 123 456');
  const twice = normalizePassportNumber(once);
  assert.equal(once, twice);
});

test('normalizePassportNumber handles tabs/newlines as whitespace too', () => {
  assert.equal(normalizePassportNumber('AB\t1234\n567'), 'AB1234567');
});

test('normalizePassportNumber leaves an already-normalized value unchanged', () => {
  assert.equal(normalizePassportNumber('AB1234567'), 'AB1234567');
});
