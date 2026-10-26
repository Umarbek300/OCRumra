import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lookupCountryCapital } from '../src/visa/countryCapitalLookup.js';

test('UZBEKISTAN -> Tashkent', () => {
  const result = lookupCountryCapital('UZBEKISTAN');
  assert.deepEqual(result, { ok: true, entry: { country: 'UZBEKISTAN', capitalCity: 'Tashkent' } });
});

test('TAJIKISTAN -> Dushanbe', () => {
  const result = lookupCountryCapital('TAJIKISTAN');
  assert.deepEqual(result, { ok: true, entry: { country: 'TAJIKISTAN', capitalCity: 'Dushanbe' } });
});

test('lowercase input still matches (case-insensitive)', () => {
  const result = lookupCountryCapital('uzbekistan');
  assert.deepEqual(result, { ok: true, entry: { country: 'UZBEKISTAN', capitalCity: 'Tashkent' } });
});

test('surrounding whitespace is trimmed before matching', () => {
  const result = lookupCountryCapital('  Tajikistan  ');
  assert.deepEqual(result, { ok: true, entry: { country: 'TAJIKISTAN', capitalCity: 'Dushanbe' } });
});

test('unknown nationality is rejected, never guessed', () => {
  const result = lookupCountryCapital('KAZAKHSTAN');
  assert.deepEqual(result, { ok: false, reason: 'UNKNOWN_NATIONALITY' });
});

test('empty string is rejected', () => {
  const result = lookupCountryCapital('');
  assert.deepEqual(result, { ok: false, reason: 'UNKNOWN_NATIONALITY' });
});
