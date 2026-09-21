import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ENHANCED_FALLBACK_ATTEMPTS } from '../src/ocr/mrz/enhancedFallbackAttempts.js';

const MAX_BOUNDED_ATTEMPTS = 8;

test('ENHANCED_FALLBACK_ATTEMPTS is a small, fixed, enumerable list (bounded, not a dynamic cross-product)', () => {
  assert.ok(Array.isArray(ENHANCED_FALLBACK_ATTEMPTS));
  assert.ok(
    ENHANCED_FALLBACK_ATTEMPTS.length > 0 && ENHANCED_FALLBACK_ATTEMPTS.length <= MAX_BOUNDED_ATTEMPTS,
    `expected a small bounded list (<= ${MAX_BOUNDED_ATTEMPTS}), got ${ENHANCED_FALLBACK_ATTEMPTS.length}`,
  );
});

test('every attempt only uses scale 3 or 4 (2x/150 is already covered by the existing fallback stages)', () => {
  for (const attempt of ENHANCED_FALLBACK_ATTEMPTS) {
    assert.ok([3, 4].includes(attempt.scale), `unexpected scale ${attempt.scale}`);
  }
});

test('every binarized attempt only uses threshold 120, 150, or 180', () => {
  for (const attempt of ENHANCED_FALLBACK_ATTEMPTS) {
    if (attempt.threshold !== undefined) {
      assert.ok([120, 150, 180].includes(attempt.threshold), `unexpected threshold ${attempt.threshold}`);
    }
  }
});

test('covers a plain (non-binarized) attempt at both scale 3 and scale 4', () => {
  const plainScales = ENHANCED_FALLBACK_ATTEMPTS.filter((attempt) => attempt.threshold === undefined).map(
    (attempt) => attempt.scale,
  );
  assert.deepEqual([...new Set(plainScales)].sort(), [3, 4]);
});

test('covers every requested threshold (120/150/180) at both scale 3 and scale 4', () => {
  for (const scale of [3, 4]) {
    const thresholdsAtScale = ENHANCED_FALLBACK_ATTEMPTS.filter((attempt) => attempt.scale === scale && attempt.threshold !== undefined).map(
      (attempt) => attempt.threshold,
    );
    assert.deepEqual([...new Set(thresholdsAtScale)].sort(), [120, 150, 180], `scale ${scale} is missing a threshold variant`);
  }
});

test('has no duplicate (scale, threshold) combinations', () => {
  const keys = ENHANCED_FALLBACK_ATTEMPTS.map((attempt) => `${attempt.scale}:${attempt.threshold ?? 'plain'}`);
  assert.equal(new Set(keys).size, keys.length, 'duplicate attempt configuration found');
});
