import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  computeBandStats,
  computeRowInkRatios,
  estimateContentRightEdgePercent,
  computeRightEdgeGeometryMetrics,
  formatRightEdgeGeometryMetrics,
} from '../scripts/tmp-diagnostic-mrz-right-edge-geometry.js';

const LIGHT = 240; // background-like pixel value
const DARK = 30; // ink-like pixel value

function buildRow(pattern: number[]): number[] {
  return pattern;
}

test('computeBandStats reports high inkRatio and low meanIntensity for an all-dark band', () => {
  const width = 10;
  const height = 2;
  const data = Buffer.from([...buildRow(new Array(width).fill(DARK)), ...buildRow(new Array(width).fill(DARK))]);

  const stats = computeBandStats(data, width, height, 0, width);

  assert.strictEqual(stats.inkRatio, 1);
  assert.strictEqual(stats.meanIntensity, DARK);
  assert.strictEqual(stats.stdevIntensity, 0);
});

test('computeBandStats reports zero inkRatio and high meanIntensity for an all-light (background) band', () => {
  const width = 10;
  const height = 2;
  const data = Buffer.from([...buildRow(new Array(width).fill(LIGHT)), ...buildRow(new Array(width).fill(LIGHT))]);

  const stats = computeBandStats(data, width, height, 0, width);

  assert.strictEqual(stats.inkRatio, 0);
  assert.strictEqual(stats.meanIntensity, LIGHT);
});

test('computeBandStats restricts its statistics to the requested [xStart, xEnd) column range only', () => {
  const width = 10;
  const height = 1;
  // Left half dark (ink), right half light (background).
  const row = [...new Array(5).fill(DARK), ...new Array(5).fill(LIGHT)];
  const data = Buffer.from(row);

  const leftBand = computeBandStats(data, width, height, 0, 5);
  const rightBand = computeBandStats(data, width, height, 5, 10);

  assert.strictEqual(leftBand.inkRatio, 1);
  assert.strictEqual(rightBand.inkRatio, 0);
});

test('computeRowInkRatios reports one ink ratio per row, matching each row\'s own dark-pixel fraction', () => {
  const width = 10;
  const height = 3;
  // Row 0: all dark, row 1: all light, row 2: half dark half light.
  const rows = [new Array(width).fill(DARK), new Array(width).fill(LIGHT), [...new Array(5).fill(DARK), ...new Array(5).fill(LIGHT)]];
  const data = Buffer.from(rows.flat());

  const ratios = computeRowInkRatios(data, width, height, 0, width);

  assert.deepEqual(ratios, [1, 0, 0.5]);
});

test('computeRightEdgeGeometryMetrics flags a uniformly dark band as likelyUniformDarkBlock (a shadow/border/table signature, not text)', () => {
  const width = 100;
  const height = 20;
  // Every row identically ~99% dark in the right-edge region — the exact
  // shape observed in a real production run (last5% band, inkRatio~0.98)
  // that first raised the need for this row-uniformity check.
  const row = new Array(width).fill(DARK);
  const data = Buffer.from(Array.from({ length: height }, () => row).flat());

  const metrics = computeRightEdgeGeometryMetrics(data, width, height);

  for (const band of metrics.bands) {
    assert.strictEqual(band.rowInkRatioStdev, 0);
    assert.strictEqual(band.likelyUniformDarkBlock, true);
  }
});

test('computeRightEdgeGeometryMetrics does not flag a text-like band (alternating dark text rows and light gap rows) as a uniform dark block', () => {
  const width = 100;
  const height = 20;
  // Alternating rows: dark (a character stroke row) / light (the gap
  // between character rows) — text-shaped variation, not a solid block.
  const darkRow = new Array(width).fill(DARK);
  const lightRow = new Array(width).fill(LIGHT);
  const rows = Array.from({ length: height }, (_, i) => (i % 2 === 0 ? darkRow : lightRow));
  const data = Buffer.from(rows.flat());

  const metrics = computeRightEdgeGeometryMetrics(data, width, height);

  for (const band of metrics.bands) {
    assert.strictEqual(band.likelyUniformDarkBlock, false);
  }
});

test('estimateContentRightEdgePercent finds the boundary between ink content and a trailing blank background region', () => {
  const width = 100;
  const height = 4;
  // Ink for the first 70 columns, blank background for the last 30 —
  // simulates a photographed MRZ line that genuinely ends at 70% width,
  // with real (non-cut-off) background margin beyond it.
  const row = [...new Array(70).fill(DARK), ...new Array(30).fill(LIGHT)];
  const data = Buffer.from(Array.from({ length: height }, () => row).flat());

  const estimate = estimateContentRightEdgePercent(data, width, height);

  assert.ok(estimate >= 68 && estimate <= 72, `expected ~70%, got ${estimate}`);
});

test('estimateContentRightEdgePercent returns near 100% when ink content runs all the way to the right edge', () => {
  const width = 100;
  const height = 4;
  const row = new Array(width).fill(DARK);
  const data = Buffer.from(Array.from({ length: height }, () => row).flat());

  const estimate = estimateContentRightEdgePercent(data, width, height);

  assert.ok(estimate >= 98, `expected ~100%, got ${estimate}`);
});

test('computeRightEdgeGeometryMetrics reports near-zero inkRatio in every right-edge band for a fully blank right portion', () => {
  const width = 100;
  const height = 4;
  const row = [...new Array(50).fill(DARK), ...new Array(50).fill(LIGHT)];
  const data = Buffer.from(Array.from({ length: height }, () => row).flat());

  const metrics = computeRightEdgeGeometryMetrics(data, width, height);

  for (const band of metrics.bands) {
    assert.strictEqual(band.inkRatio, 0, `band last${band.bandPercent}% should be blank`);
  }
  assert.ok(metrics.estimatedContentRightEdgePercent <= 52);
  assert.ok(metrics.distanceFromImageRightEdgePercent >= 48);
});

test('computeRightEdgeGeometryMetrics reports non-zero inkRatio in right-edge bands when ink extends to the image edge', () => {
  const width = 100;
  const height = 4;
  const row = new Array(width).fill(DARK);
  const data = Buffer.from(Array.from({ length: height }, () => row).flat());

  const metrics = computeRightEdgeGeometryMetrics(data, width, height);

  for (const band of metrics.bands) {
    assert.strictEqual(band.inkRatio, 1);
  }
});

test('formatRightEdgeGeometryMetrics never includes raw pixel data, only labeled numeric statistics', () => {
  const width = 100;
  const height = 4;
  const row = new Array(width).fill(DARK);
  const data = Buffer.from(Array.from({ length: height }, () => row).flat());
  const metrics = computeRightEdgeGeometryMetrics(data, width, height);

  const formatted = formatRightEdgeGeometryMetrics(0, metrics);

  assert.ok(formatted.includes('candidate=0'));
  assert.ok(formatted.includes('cropWidth='));
  assert.ok(formatted.includes('cropHeight='));
  assert.ok(formatted.includes('meanIntensity='));
  assert.ok(formatted.includes('stdevIntensity='));
  assert.ok(formatted.includes('inkRatio='));
  assert.ok(formatted.includes('rowInkRatioStdev='));
  assert.ok(formatted.includes('likelyUniformDarkBlock='));
  assert.ok(formatted.includes('estimatedContentRightEdgePercent='));
  assert.ok(formatted.includes('distanceFromImageRightEdgePercent='));
});
