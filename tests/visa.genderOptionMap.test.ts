import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapGenderToVisitSaudiOption } from '../src/visa/genderOptionMap.js';

test("'Erkak' -> Male", () => {
  const result = mapGenderToVisitSaudiOption('Erkak');
  assert.deepEqual(result, { ok: true, genderOption: 'Male' });
});

test("'Ayol' -> Female", () => {
  const result = mapGenderToVisitSaudiOption('Ayol');
  assert.deepEqual(result, { ok: true, genderOption: 'Female' });
});

test('surrounding whitespace is trimmed before matching', () => {
  const result = mapGenderToVisitSaudiOption('  Erkak  ');
  assert.deepEqual(result, { ok: true, genderOption: 'Male' });
});

test('empty string (unspecified gender) is rejected, never guessed', () => {
  const result = mapGenderToVisitSaudiOption('');
  assert.deepEqual(result, { ok: false, reason: 'UNRECOGNIZED_GENDER' });
});

test("English 'male' is rejected -- only the Sheet's own Uzbek labels are recognized", () => {
  const result = mapGenderToVisitSaudiOption('male');
  assert.deepEqual(result, { ok: false, reason: 'UNRECOGNIZED_GENDER' });
});

test('an unrelated string is rejected', () => {
  const result = mapGenderToVisitSaudiOption('noma\'lum');
  assert.deepEqual(result, { ok: false, reason: 'UNRECOGNIZED_GENDER' });
});
