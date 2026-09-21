import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findMrzCandidateRegions } from '../src/ocr/mrz/findMrzCandidateRegions.js';

test('findMrzCandidateRegions returns multiple candidates, tightest first', () => {
  const candidates = findMrzCandidateRegions(1000, 2000);
  assert.ok(candidates.length >= 2, 'must search more than one region, not a single fixed guess');

  for (let i = 1; i < candidates.length; i++) {
    assert.ok(candidates[i]!.top < candidates[i - 1]!.top, 'candidates must widen (move up) after the first, tightest one');
  }
});

test('findMrzCandidateRegions never returns a region beyond the image bounds', () => {
  const height = 2000;
  const candidates = findMrzCandidateRegions(1000, height);
  for (const candidate of candidates) {
    assert.ok(candidate.top >= 0);
    assert.ok(candidate.top + candidate.height <= height);
    assert.ok(candidate.height > 0);
  }
});

test('findMrzCandidateRegions scales with the image height', () => {
  const small = findMrzCandidateRegions(500, 400);
  const large = findMrzCandidateRegions(500, 4000);
  assert.ok(large[0]!.height > small[0]!.height);
});
