import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeMaskGeometry } from '../scripts/tmp-diagnostic-mrz-edge-mask-ab.js';

test('computeMaskGeometry computes a mask rectangle covering exactly the requested trailing percentage of width', () => {
  const { maskLeft, maskWidth } = computeMaskGeometry(1000, 5);

  assert.strictEqual(maskWidth, 50);
  assert.strictEqual(maskLeft, 950);
  assert.strictEqual(maskLeft + maskWidth, 1000);
});

test('computeMaskGeometry rounds to the nearest pixel for a width not evenly divisible by the percentage', () => {
  const { maskLeft, maskWidth } = computeMaskGeometry(1080, 5);

  // 1080 * 0.05 = 54 exactly, but exercise a width that isn't a clean
  // multiple to confirm rounding behavior.
  const { maskLeft: altLeft, maskWidth: altWidth } = computeMaskGeometry(1081, 5);
  assert.strictEqual(maskWidth, 54);
  assert.strictEqual(maskLeft, 1026);
  assert.ok(altWidth >= 54 && altWidth <= 55);
  assert.strictEqual(altLeft + altWidth, 1081);
});

test('computeMaskGeometry never produces a negative maskLeft or zero maskWidth, even for a tiny width', () => {
  const { maskLeft, maskWidth } = computeMaskGeometry(1, 5);

  assert.ok(maskLeft >= 0);
  assert.ok(maskWidth >= 1);
});

test('computeMaskGeometry scales the mask width proportionally with the requested percentage', () => {
  const fivePercent = computeMaskGeometry(1000, 5);
  const twentyPercent = computeMaskGeometry(1000, 20);

  assert.ok(twentyPercent.maskWidth > fivePercent.maskWidth);
  assert.strictEqual(twentyPercent.maskWidth, 200);
});
