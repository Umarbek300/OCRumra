import assert from 'node:assert/strict';
import { test } from 'node:test';
import { looksLikeMrzLine } from '../src/ocr/mrz/looksLikeMrzLine.js';

const VALID_LINE = 'P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<';

test('looksLikeMrzLine accepts a well-formed 44-char MRZ-alphabet line with filler', () => {
  assert.equal(VALID_LINE.length, 44);
  assert.equal(looksLikeMrzLine(VALID_LINE), true);
});

test('looksLikeMrzLine rejects the wrong length', () => {
  assert.equal(looksLikeMrzLine(VALID_LINE.slice(0, 40)), false);
  assert.equal(looksLikeMrzLine(`${VALID_LINE}X`), false);
});

test('looksLikeMrzLine rejects characters outside the MRZ alphabet', () => {
  const withLowercase = `${VALID_LINE.slice(0, 43)}a`;
  assert.equal(looksLikeMrzLine(withLowercase), false);
});

test('looksLikeMrzLine rejects a line with no filler at all (real MRZ always has padding)', () => {
  const noFiller = 'A'.repeat(44);
  assert.equal(looksLikeMrzLine(noFiller), false);
});

test('looksLikeMrzLine respects a custom expected length', () => {
  assert.equal(looksLikeMrzLine('AB<', 3), true);
  assert.equal(looksLikeMrzLine('AB<', 4), false);
});
