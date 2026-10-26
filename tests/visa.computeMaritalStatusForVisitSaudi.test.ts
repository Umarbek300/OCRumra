import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeMaritalStatusForVisitSaudi } from '../src/visa/computeMaritalStatusForVisitSaudi.js';

test('exactly 20 years old on the departure date (birthday is today) -> MARRIED', () => {
  const result = computeMaritalStatusForVisitSaudi('2006-10-26', '2026-10-26');
  assert.deepEqual(result, { ok: true, maritalStatus: 'MARRIED' });
});

test('birthday is one day AFTER the departure date (still 19) -> SINGLE', () => {
  const result = computeMaritalStatusForVisitSaudi('2006-10-27', '2026-10-26');
  assert.deepEqual(result, { ok: true, maritalStatus: 'SINGLE' });
});

test('birthday was one day BEFORE the departure date (already 20) -> MARRIED', () => {
  const result = computeMaritalStatusForVisitSaudi('2006-10-25', '2026-10-26');
  assert.deepEqual(result, { ok: true, maritalStatus: 'MARRIED' });
});

test('year boundary: birthday is Dec 31, departure is Jan 1 the following year (birthday not yet reached) -> SINGLE', () => {
  const result = computeMaritalStatusForVisitSaudi('2006-12-31', '2026-01-01');
  assert.deepEqual(result, { ok: true, maritalStatus: 'SINGLE' });
});

test('month boundary: birthday Jan 1, departure Dec 31 the same calendar year (birthday already passed) -> MARRIED', () => {
  const result = computeMaritalStatusForVisitSaudi('2006-01-01', '2026-12-31');
  assert.deepEqual(result, { ok: true, maritalStatus: 'MARRIED' });
});

test('leap-year birth date (Feb 29), departure also in a leap year on Feb 29 (exact 20th birthday) -> MARRIED', () => {
  const result = computeMaritalStatusForVisitSaudi('2008-02-29', '2028-02-29');
  assert.deepEqual(result, { ok: true, maritalStatus: 'MARRIED' });
});

test('leap-year birth date (Feb 29), departure in a non-leap year on Feb 28 (birthday not yet reached -- effective birthday is March 1) -> SINGLE', () => {
  const result = computeMaritalStatusForVisitSaudi('2008-02-29', '2027-02-28');
  assert.deepEqual(result, { ok: true, maritalStatus: 'SINGLE' });
});

test('leap-year birth date (Feb 29), departure in a non-leap year on March 1 (effective birthday reached, but only 19) -> SINGLE', () => {
  const result = computeMaritalStatusForVisitSaudi('2008-02-29', '2027-03-01');
  assert.deepEqual(result, { ok: true, maritalStatus: 'SINGLE' });
});

test('leap-year birth date (Feb 29), departure reaches 20 on the effective (March 1) birthday in a non-leap year', () => {
  const result = computeMaritalStatusForVisitSaudi('2008-02-29', '2028-03-01');
  // 2028 IS a leap year, so Feb 29, 2028 exists and already passed by March 1 -> already 20.
  assert.deepEqual(result, { ok: true, maritalStatus: 'MARRIED' });
});

test('Gregorian century rule: 1900 is NOT a leap year, so "1900-02-29" is not a real date -> rejected as invalid date of birth', () => {
  // 1900 % 4 === 0 but 1900 % 100 === 0 and 1900 % 400 !== 0 -- the exact
  // century-exception case a naive "divisible by 4" check would get wrong.
  const result = computeMaritalStatusForVisitSaudi('1900-02-29', '2026-10-26');
  assert.deepEqual(result, { ok: false, reason: 'INVALID_DATE_OF_BIRTH' });
});

test('Gregorian century rule: 2000 IS a leap year (divisible by 400), so "2000-02-29" is a real date of birth and is accepted', () => {
  // 2000 % 400 === 0 -- the exact century case where the leap rule flips
  // back to "leap" despite being divisible by 100. Departure chosen as
  // 2020-03-01 (2020 is itself a leap year, so no Feb-29 special case
  // applies) for an unambiguous, independently-computed exact age of 20.
  const result = computeMaritalStatusForVisitSaudi('2000-02-29', '2020-03-01');
  assert.deepEqual(result, { ok: true, maritalStatus: 'MARRIED' });
});

test('un-padded month and day in date of birth (e.g. "2026-1-5") is rejected -- strict two-digit format required', () => {
  const result = computeMaritalStatusForVisitSaudi('2026-1-5', '2026-10-26');
  assert.deepEqual(result, { ok: false, reason: 'INVALID_DATE_OF_BIRTH' });
});

test('un-padded day only in date of birth (e.g. "2026-01-5") is rejected', () => {
  const result = computeMaritalStatusForVisitSaudi('2026-01-5', '2026-10-26');
  assert.deepEqual(result, { ok: false, reason: 'INVALID_DATE_OF_BIRTH' });
});

test('empty string date of birth is rejected', () => {
  const result = computeMaritalStatusForVisitSaudi('', '2026-10-26');
  assert.deepEqual(result, { ok: false, reason: 'INVALID_DATE_OF_BIRTH' });
});

test('malformed (non-ISO-shaped) departure date is rejected (INVALID_DEPARTURE_DATE, not silently treated as a valid date of birth-side error)', () => {
  const result = computeMaritalStatusForVisitSaudi('2006-10-26', '26/10/2026');
  assert.deepEqual(result, { ok: false, reason: 'INVALID_DEPARTURE_DATE' });
});

test('un-padded month and day in departure date (e.g. "2026-1-5") is rejected -- strict two-digit format required', () => {
  const result = computeMaritalStatusForVisitSaudi('2006-10-26', '2026-1-5');
  assert.deepEqual(result, { ok: false, reason: 'INVALID_DEPARTURE_DATE' });
});

test('un-padded day only in departure date (e.g. "2026-01-5") is rejected', () => {
  const result = computeMaritalStatusForVisitSaudi('2006-10-26', '2026-01-5');
  assert.deepEqual(result, { ok: false, reason: 'INVALID_DEPARTURE_DATE' });
});

test('empty string departure date is rejected', () => {
  const result = computeMaritalStatusForVisitSaudi('2006-10-26', '');
  assert.deepEqual(result, { ok: false, reason: 'INVALID_DEPARTURE_DATE' });
});

test('invalid (calendar-impossible) date of birth is rejected, never guessed', () => {
  const result = computeMaritalStatusForVisitSaudi('2006-02-30', '2026-10-26');
  assert.deepEqual(result, { ok: false, reason: 'INVALID_DATE_OF_BIRTH' });
});

test('invalid (calendar-impossible) departure date is rejected, never guessed', () => {
  const result = computeMaritalStatusForVisitSaudi('2006-10-26', '2026-02-30');
  assert.deepEqual(result, { ok: false, reason: 'INVALID_DEPARTURE_DATE' });
});

test('malformed (non-ISO-shaped) date of birth is rejected', () => {
  const result = computeMaritalStatusForVisitSaudi('26/10/2006', '2026-10-26');
  assert.deepEqual(result, { ok: false, reason: 'INVALID_DATE_OF_BIRTH' });
});

test('a clearly underage applicant (child) is SINGLE', () => {
  const result = computeMaritalStatusForVisitSaudi('2020-01-01', '2026-10-26');
  assert.deepEqual(result, { ok: true, maritalStatus: 'SINGLE' });
});

test('a clearly over-threshold adult is MARRIED', () => {
  const result = computeMaritalStatusForVisitSaudi('1980-01-01', '2026-10-26');
  assert.deepEqual(result, { ok: true, maritalStatus: 'MARRIED' });
});
