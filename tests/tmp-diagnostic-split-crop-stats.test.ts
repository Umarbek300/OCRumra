import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import {
  computeCropStats,
  formatSplitCropDiagnosticResult,
  runSplitCropDiagnostic,
  type SplitCropDiagnosticDependencies,
} from '../scripts/tmp-diagnostic-split-crop-stats.js';

async function makeSolidGrayscaleImage(width: number, height: number, value: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: value, g: value, b: value } } })
    .png()
    .toBuffer();
}

async function makeNoisyGrayscaleImage(width: number, height: number): Promise<Buffer> {
  const pixels = Buffer.alloc(width * height);
  for (let i = 0; i < pixels.length; i++) {
    // Deterministic pseudo-noise, not Math.random(), so the test is stable.
    pixels[i] = (i * 97) % 256;
  }
  return sharp(pixels, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer();
}

test('computeCropStats reports near-zero stdev for a perfectly uniform (degenerate/blank) image', async () => {
  const image = await makeSolidGrayscaleImage(20, 20, 200);
  const stats = await computeCropStats(image);

  assert.strictEqual(stats.width, 20);
  assert.strictEqual(stats.height, 20);
  assert.ok(stats.stdev < 1, `expected near-zero stdev for a solid image, got ${stats.stdev}`);
  assert.ok(Math.abs(stats.mean - 200) < 2);
  assert.strictEqual(stats.min, stats.max);
});

test('computeCropStats reports non-trivial stdev for a varied image', async () => {
  const image = await makeNoisyGrayscaleImage(20, 20);
  const stats = await computeCropStats(image);

  assert.ok(stats.stdev > 10, `expected meaningful stdev for a varied image, got ${stats.stdev}`);
  assert.ok(stats.max > stats.min);
});

test('computeCropStats reports a non-background pixel ratio between 0 and 1', async () => {
  const image = await makeNoisyGrayscaleImage(20, 20);
  const stats = await computeCropStats(image);

  assert.ok(stats.nonBackgroundRatio >= 0 && stats.nonBackgroundRatio <= 1);
});

async function makeTinyRealImage(): Promise<Buffer> {
  return sharp({ create: { width: 10, height: 10, channels: 3, background: { r: 128, g: 128, b: 128 } } })
    .png()
    .toBuffer();
}

function buildDeps(overrides: Partial<SplitCropDiagnosticDependencies> = {}): SplitCropDiagnosticDependencies {
  return {
    cropRegion: async () => makeTinyRealImage(),
    runTesseractOcr: async () => 'irrelevant ocr text',
    ...overrides,
  };
}

test('runSplitCropDiagnostic reproduces splitLineOcr’s exact top/bottom half split', async () => {
  const cropCalls: Array<{ top: number; height: number }> = [];
  const deps = buildDeps({
    cropRegion: async (_buffer, top, height) => {
      cropCalls.push({ top, height });
      return makeTinyRealImage();
    },
  });

  await runSplitCropDiagnostic(Buffer.from('fake-image'), 816, 366, deps);

  // Matches splitLineOcr.ts exactly: halfHeight = round(366/2) = 183.
  assert.deepStrictEqual(cropCalls, [
    { top: 816, height: 183 },
    { top: 999, height: 183 },
  ]);
});

test('runSplitCropDiagnostic runs Tesseract on each half SEPARATELY, so one crashing does not hide the other’s result', async () => {
  let calls = 0;
  const deps = buildDeps({
    runTesseractOcr: async () => {
      calls += 1;
      // First call is always the top half (runSplitCropDiagnostic awaits
      // top's diagnoseHalf fully before starting bottom's).
      if (calls === 1) {
        throw new Error('Local OCR (tesseract) exited with code null (terminated by signal SIGFPE)');
      }
      return 'ocr text for the other half';
    },
  });

  const result = await runSplitCropDiagnostic(Buffer.from('fake-image'), 816, 366, deps);

  assert.strictEqual(calls, 2, 'both halves must be attempted independently');
  assert.strictEqual(result.top.tesseractOutcome, 'crashed');
  assert.match(result.top.crashSignal ?? '', /SIGFPE/);
  assert.strictEqual(result.bottom.tesseractOutcome, 'succeeded');
  assert.strictEqual(result.bottom.crashSignal, null);
});

test('runSplitCropDiagnostic reports success for both halves when neither crashes', async () => {
  const result = await runSplitCropDiagnostic(Buffer.from('fake-image'), 816, 366, buildDeps());

  assert.strictEqual(result.top.tesseractOutcome, 'succeeded');
  assert.strictEqual(result.bottom.tesseractOutcome, 'succeeded');
});

test('runSplitCropDiagnostic includes structural crop stats for both halves', async () => {
  const result = await runSplitCropDiagnostic(Buffer.from('fake-image'), 816, 366, buildDeps());

  for (const half of [result.top, result.bottom]) {
    assert.ok(typeof half.stats.width === 'number');
    assert.ok(typeof half.stats.height === 'number');
    assert.ok(typeof half.stats.mean === 'number');
    assert.ok(typeof half.stats.stdev === 'number');
    assert.ok(typeof half.stats.min === 'number');
    assert.ok(typeof half.stats.max === 'number');
    assert.ok(typeof half.stats.nonBackgroundRatio === 'number');
  }
});

test('formatSplitCropDiagnosticResult never includes raw OCR text, only structural facts', async () => {
  const deps = buildDeps({ runTesseractOcr: async () => 'P<UTOSECRETNAME<<SHOULD<NEVER<APPEAR<<<<<<<<' });
  const result = await runSplitCropDiagnostic(Buffer.from('fake-image'), 816, 366, deps);
  const formatted = formatSplitCropDiagnosticResult(result);

  assert.ok(!formatted.includes('SECRETNAME'));
  assert.ok(!formatted.includes('P<UTO'));
  assert.ok(formatted.includes('width'));
  assert.ok(formatted.includes('stdev'));
  assert.ok(formatted.includes('tesseractOutcome'));
});
