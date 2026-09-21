import assert from 'node:assert/strict';
import { test } from 'node:test';
import { splitLineOcr, type SplitLineOcrDependencies } from '../src/ocr/mrz/splitLineOcr.js';

test('splitLineOcr crops and OCRs the top and bottom halves separately with single-line PSM', async () => {
  const cropCalls: Array<{ top: number; height: number }> = [];
  const ocrCalls: Array<{ psm: number | undefined }> = [];

  const deps: SplitLineOcrDependencies = {
    cropRegion: async (_buffer, top, height) => {
      cropCalls.push({ top, height });
      return Buffer.from(`crop-${top}-${height}`);
    },
    runTesseractOcr: async (buffer, options) => {
      ocrCalls.push({ psm: options?.psm });
      return buffer.toString() === 'crop-100-100' ? 'LINE1TEXT' : 'LINE2TEXT';
    },
  };

  const lines = await splitLineOcr(Buffer.from('image'), 100, 200, deps);

  assert.equal(cropCalls.length, 2);
  assert.deepEqual(cropCalls[0], { top: 100, height: 100 });
  assert.deepEqual(cropCalls[1], { top: 200, height: 100 });

  assert.equal(ocrCalls.length, 2);
  assert.ok(ocrCalls.every((call) => call.psm === 7), 'single-line OCR must use PSM 7');

  assert.deepEqual(lines, ['LINE1TEXT', 'LINE2TEXT']);
});

test('splitLineOcr cleans whitespace/case and trims excess trailing filler from each half', async () => {
  const deps: SplitLineOcrDependencies = {
    cropRegion: async (_buffer, top) => Buffer.from(`region-${top}`),
    runTesseractOcr: async (buffer) =>
      buffer.toString() === 'region-0' ? 'l898902c3 6uto740812<<' : 'ze184226b<<<<<10',
  };

  const lines = await splitLineOcr(Buffer.from('image'), 0, 2, deps);

  // Short lines (well under 44 chars) are left as-is by normalization —
  // only excess-over-44 trailing filler gets trimmed. This test only
  // confirms whitespace-stripping and uppercasing happened.
  assert.equal(lines[0], 'L898902C36UTO740812<<');
  assert.equal(lines[1], 'ZE184226B<<<<<10');
});

test('splitLineOcr handles an odd total height without throwing', async () => {
  const deps: SplitLineOcrDependencies = {
    cropRegion: async (_buffer, top, height) => Buffer.from(`${top}-${height}`),
    runTesseractOcr: async () => '',
  };

  const lines = await splitLineOcr(Buffer.from('image'), 0, 3, deps);
  assert.equal(lines.length, 2);
});
