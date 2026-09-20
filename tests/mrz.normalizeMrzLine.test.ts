import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeMrzLineLength, TD3_MRZ_LINE_LENGTH } from '../src/ocr/mrz/normalizeMrzLine.js';

const VALID_LINE_2 = 'L898902C36UTO7408122F1204159ZE184226B<<<<<10';

test('normalizeMrzLineLength trims one excess trailing filler character', () => {
  assert.equal(VALID_LINE_2.length, TD3_MRZ_LINE_LENGTH);
  const withOneExtra = `${VALID_LINE_2}<`;
  assert.equal(normalizeMrzLineLength(withOneExtra), VALID_LINE_2);
});

test('normalizeMrzLineLength trims multiple excess trailing filler characters', () => {
  const withThreeExtra = `${VALID_LINE_2}<<<`;
  assert.equal(normalizeMrzLineLength(withThreeExtra), VALID_LINE_2);
});

test('normalizeMrzLineLength leaves a line at the expected length untouched', () => {
  assert.equal(normalizeMrzLineLength(VALID_LINE_2), VALID_LINE_2);
});

test('normalizeMrzLineLength leaves a shorter-than-expected line untouched (never pads/invents)', () => {
  const short = VALID_LINE_2.slice(0, 40);
  assert.equal(normalizeMrzLineLength(short), short);
});

test('normalizeMrzLineLength does NOT trim when the excess character is not trailing filler', () => {
  // Excess length here comes from a real-looking character, not '<' — must
  // be left alone rather than guessing which character to drop.
  const withNonFillerExcess = `${VALID_LINE_2.slice(0, -1)}AB`; // 45 chars, ends in a letter
  assert.equal(normalizeMrzLineLength(withNonFillerExcess), withNonFillerExcess);
});

test('normalizeMrzLineLength respects a custom expected length', () => {
  const line = 'ABC<<';
  assert.equal(normalizeMrzLineLength(line, 3), 'ABC');
});
