import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DESKEW_FALLBACK_ATTEMPTS, TRIM_FALLBACK_ATTEMPTS } from '../src/ocr/mrz/geometryFallbackAttempts.js';

test('TRIM_FALLBACK_ATTEMPTS is a small, fixed, bounded list', () => {
  assert.ok(Array.isArray(TRIM_FALLBACK_ATTEMPTS));
  assert.ok(TRIM_FALLBACK_ATTEMPTS.length > 0 && TRIM_FALLBACK_ATTEMPTS.length <= 4);
});

test('TRIM_FALLBACK_ATTEMPTS covers both a plain and a binarized variant, with no duplicates', () => {
  const binarizeFlags = TRIM_FALLBACK_ATTEMPTS.map((attempt) => attempt.binarize);
  assert.deepEqual([...new Set(binarizeFlags)].sort(), [false, true]);
  assert.equal(new Set(binarizeFlags).size, binarizeFlags.length, 'duplicate attempt configuration found');
});

test('DESKEW_FALLBACK_ATTEMPTS is a small, fixed, bounded list', () => {
  assert.ok(Array.isArray(DESKEW_FALLBACK_ATTEMPTS));
  assert.ok(DESKEW_FALLBACK_ATTEMPTS.length > 0 && DESKEW_FALLBACK_ATTEMPTS.length <= 6);
});

test('DESKEW_FALLBACK_ATTEMPTS uses exactly the small angles -4, -2, 2, 4 (no 0 — already covered by stages 2/3)', () => {
  const angles = DESKEW_FALLBACK_ATTEMPTS.map((attempt) => attempt.rotateDegrees).sort((a, b) => a - b);
  assert.deepEqual(angles, [-4, -2, 2, 4]);
});

test('DESKEW_FALLBACK_ATTEMPTS has no duplicate angles', () => {
  const angles = DESKEW_FALLBACK_ATTEMPTS.map((attempt) => attempt.rotateDegrees);
  assert.equal(new Set(angles).size, angles.length, 'duplicate angle found');
});

test('the total new bounded attempts (trim + deskew) is exactly 6, as agreed', () => {
  assert.equal(TRIM_FALLBACK_ATTEMPTS.length + DESKEW_FALLBACK_ATTEMPTS.length, 6);
});
