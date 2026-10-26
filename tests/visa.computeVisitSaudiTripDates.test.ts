import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeVisitSaudiTripDates } from '../src/visa/computeVisitSaudiTripDates.js';

test('plain mid-month departure -> arrival is the same date, return is +14 days', () => {
  const result = computeVisitSaudiTripDates('2026-10-26');
  assert.deepEqual(result, { ok: true, dates: { arrivalDate: '2026-10-26', departureFromSaudiDate: '2026-11-09' } });
});

test('+14 days crossing a month boundary (October -> November)', () => {
  const result = computeVisitSaudiTripDates('2026-10-20');
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('unreachable');
  assert.equal(result.dates.departureFromSaudiDate, '2026-11-03');
});

test('+14 days crossing a year boundary (December -> January)', () => {
  const result = computeVisitSaudiTripDates('2026-12-20');
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('unreachable');
  assert.equal(result.dates.departureFromSaudiDate, '2027-01-03');
});

test('+14 days crossing a leap-year February into March (2028 is a leap year)', () => {
  const result = computeVisitSaudiTripDates('2028-02-16');
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('unreachable');
  assert.equal(result.dates.departureFromSaudiDate, '2028-03-01');
});

test('+14 days starting later in a leap-year February, still crossing into March', () => {
  const result = computeVisitSaudiTripDates('2028-02-20');
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('unreachable');
  assert.equal(result.dates.departureFromSaudiDate, '2028-03-05');
});

test('+14 days crossing a non-leap-year February (2026 is not a leap year) into March', () => {
  const result = computeVisitSaudiTripDates('2026-02-16');
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('unreachable');
  // 2026 Feb has 28 days: 16 + 14 = 30 -> 30 - 28 = 2 -> March 2.
  assert.equal(result.dates.departureFromSaudiDate, '2026-03-02');
});

test('calendar-impossible departure date (February 30) is rejected, never silently fixed', () => {
  const result = computeVisitSaudiTripDates('2026-02-30');
  assert.deepEqual(result, { ok: false, reason: 'INVALID_DEPARTURE_DATE' });
});

test('malformed (non-ISO-shaped) departure date is rejected', () => {
  const result = computeVisitSaudiTripDates('26/10/2026');
  assert.deepEqual(result, { ok: false, reason: 'INVALID_DEPARTURE_DATE' });
});

test('un-padded month and day (e.g. "2026-1-5" instead of "2026-01-05") is rejected -- the strict two-digit format is required, not just calendar validity', () => {
  const result = computeVisitSaudiTripDates('2026-1-5');
  assert.deepEqual(result, { ok: false, reason: 'INVALID_DEPARTURE_DATE' });
});

test('un-padded day only (e.g. "2026-01-5") is rejected', () => {
  const result = computeVisitSaudiTripDates('2026-01-5');
  assert.deepEqual(result, { ok: false, reason: 'INVALID_DEPARTURE_DATE' });
});

test('empty string departure date is rejected', () => {
  const result = computeVisitSaudiTripDates('');
  assert.deepEqual(result, { ok: false, reason: 'INVALID_DEPARTURE_DATE' });
});

test('April 31 (a real month with only 30 days) is rejected', () => {
  const result = computeVisitSaudiTripDates('2026-04-31');
  assert.deepEqual(result, { ok: false, reason: 'INVALID_DEPARTURE_DATE' });
});
