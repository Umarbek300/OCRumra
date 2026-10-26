import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapGenderToProfessionForVisitSaudi } from '../src/visa/genderProfessionMap.js';

test("'Erkak' -> WORKER", () => {
  const result = mapGenderToProfessionForVisitSaudi('Erkak');
  assert.deepEqual(result, { ok: true, profession: 'WORKER' });
});

test("'Ayol' -> HOUSE WIFE", () => {
  const result = mapGenderToProfessionForVisitSaudi('Ayol');
  assert.deepEqual(result, { ok: true, profession: 'HOUSE WIFE' });
});

test('surrounding whitespace is trimmed before matching', () => {
  const result = mapGenderToProfessionForVisitSaudi('  Erkak  ');
  assert.deepEqual(result, { ok: true, profession: 'WORKER' });
});

test('empty string (unspecified gender) is rejected, never guessed', () => {
  const result = mapGenderToProfessionForVisitSaudi('');
  assert.deepEqual(result, { ok: false, reason: 'UNRECOGNIZED_GENDER' });
});

test("English 'male' is rejected -- only the Sheet's own Uzbek labels are recognized", () => {
  const result = mapGenderToProfessionForVisitSaudi('male');
  assert.deepEqual(result, { ok: false, reason: 'UNRECOGNIZED_GENDER' });
});

test('an unrelated string is rejected', () => {
  const result = mapGenderToProfessionForVisitSaudi('noma\'lum');
  assert.deepEqual(result, { ok: false, reason: 'UNRECOGNIZED_GENDER' });
});
