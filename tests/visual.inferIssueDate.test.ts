import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inferIssueDate } from '../src/ocr/visual/inferIssueDate.js';

test('inferIssueDate returns the one candidate that is not a known date', () => {
  const candidates = ['1990-05-12', '2020-01-15', '2030-01-15'];
  const known = ['1990-05-12', '2030-01-15']; // dateOfBirth, passportExpiryDate
  assert.equal(inferIssueDate(candidates, known), '2020-01-15');
});

test('inferIssueDate returns null when no candidates were found', () => {
  assert.equal(inferIssueDate([], ['1990-05-12', '2030-01-15']), null);
});

test('inferIssueDate returns null when every candidate matches a known date (nothing left)', () => {
  const candidates = ['1990-05-12', '2030-01-15'];
  const known = ['1990-05-12', '2030-01-15'];
  assert.equal(inferIssueDate(candidates, known), null);
});

test('inferIssueDate returns null when more than one unexplained candidate remains (ambiguous, never guesses)', () => {
  const candidates = ['1990-05-12', '2020-01-15', '2021-06-01', '2030-01-15'];
  const known = ['1990-05-12', '2030-01-15'];
  assert.equal(inferIssueDate(candidates, known), null);
});

test('inferIssueDate works with only one known date available', () => {
  const candidates = ['1990-05-12', '2020-01-15'];
  const known = ['1990-05-12']; // e.g. expiry date wasn't itself readable
  assert.equal(inferIssueDate(candidates, known), '2020-01-15');
});

test('inferIssueDate returns null when there are no known dates to eliminate against', () => {
  const candidates = ['2020-01-15'];
  assert.equal(inferIssueDate(candidates, []), null);
});

test('inferIssueDate treats duplicate candidates as a single value', () => {
  const candidates = ['1990-05-12', '2020-01-15', '2020-01-15', '2030-01-15'];
  const known = ['1990-05-12', '2030-01-15'];
  assert.equal(inferIssueDate(candidates, known), '2020-01-15');
});
