import assert from 'node:assert/strict';
import { test } from 'node:test';
import { splitLineOcr, type SplitLineOcrDependencies } from '../src/ocr/mrz/splitLineOcr.js';

test('splitLineOcr crops and OCRs the top and bottom halves separately with single-line PSM and LSTM-only engine mode', async () => {
  const cropCalls: Array<{ top: number; height: number }> = [];
  const ocrCalls: Array<{ psm: number | undefined; oem: number | undefined }> = [];

  const deps: SplitLineOcrDependencies = {
    cropRegion: async (_buffer, top, height) => {
      cropCalls.push({ top, height });
      return Buffer.from(`crop-${top}-${height}`);
    },
    runTesseractOcr: async (buffer, options) => {
      ocrCalls.push({ psm: options?.psm, oem: options?.oem });
      return buffer.toString() === 'crop-100-100' ? 'LINE1TEXT' : 'LINE2TEXT';
    },
  };

  const lines = await splitLineOcr(Buffer.from('image'), 100, 200, deps);

  assert.equal(cropCalls.length, 2);
  assert.deepEqual(cropCalls[0], { top: 100, height: 100 });
  assert.deepEqual(cropCalls[1], { top: 200, height: 100 });

  assert.equal(ocrCalls.length, 2);
  assert.ok(ocrCalls.every((call) => call.psm === 7), 'single-line OCR must use PSM 7');
  assert.ok(ocrCalls.every((call) => call.oem === 1), 'single-line OCR must request LSTM-only engine mode (oem=1)');

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

// --- Subprocess-crash recovery (Promise.allSettled) ---
//
// splitLineOcr crops the top/bottom halves independently, then OCRs them
// concurrently. Production evidence (message 270, candidate=0, TOP half,
// --psm 7) showed the real `tesseract` binary can be terminated by a signal
// (SIGFPE) for one half while the other half succeeds — previously, since
// both OCR calls were combined via Promise.all, the first rejection
// discarded the other half's already-computed result and propagated an
// uncaught rejection all the way out of createLocalProvider().extract(),
// skipping every remaining fallback stage and candidate region. These
// tests establish that a crashed/rejected half must never discard the
// other half's result, and must never make splitLineOcr itself reject —
// the crashed half's line simply becomes '', identical in shape to
// Tesseract legitimately reading no recognizable text (already handled by
// parseAndValidateMrz without any special-casing).

test('splitLineOcr preserves the BOTTOM half’s result when the TOP half’s OCR process crashes', async () => {
  const deps: SplitLineOcrDependencies = {
    cropRegion: async (_buffer, top, height) => Buffer.from(`crop-${top}-${height}`),
    runTesseractOcr: async (buffer) => {
      if (buffer.toString() === 'crop-100-50') {
        throw new Error('Local OCR (tesseract) exited with code null (terminated by signal SIGFPE)');
      }
      return 'ZE184226B<<<<<10';
    },
  };

  const lines = await splitLineOcr(Buffer.from('image'), 100, 100, deps);

  assert.deepEqual(lines, ['', 'ZE184226B<<<<<10']);
});

test('splitLineOcr preserves the TOP half’s result when the BOTTOM half’s OCR process crashes', async () => {
  const deps: SplitLineOcrDependencies = {
    cropRegion: async (_buffer, top, height) => Buffer.from(`crop-${top}-${height}`),
    runTesseractOcr: async (buffer) => {
      if (buffer.toString() === 'crop-150-50') {
        throw new Error('Local OCR (tesseract) exited with code null (terminated by signal SIGFPE)');
      }
      return 'L898902C36UTO7408122';
    },
  };

  const lines = await splitLineOcr(Buffer.from('image'), 100, 100, deps);

  assert.deepEqual(lines, ['L898902C36UTO7408122', '']);
});

test('splitLineOcr returns two empty lines (controlled failure) when both halves crash', async () => {
  const deps: SplitLineOcrDependencies = {
    cropRegion: async (_buffer, top, height) => Buffer.from(`crop-${top}-${height}`),
    runTesseractOcr: async () => {
      throw new Error('Local OCR (tesseract) exited with code null (terminated by signal SIGFPE)');
    },
  };

  const lines = await splitLineOcr(Buffer.from('image'), 100, 100, deps);

  assert.deepEqual(lines, ['', '']);
});

test('splitLineOcr recovers from a non-signal subprocess failure the same way (no message-content parsing)', async () => {
  const deps: SplitLineOcrDependencies = {
    cropRegion: async (_buffer, top, height) => Buffer.from(`crop-${top}-${height}`),
    runTesseractOcr: async (buffer) => {
      if (buffer.toString() === 'crop-100-50') {
        // Plain non-zero exit, no signal at all — must be treated exactly
        // like a signal crash: message content is never inspected.
        throw new Error('Local OCR (tesseract) exited with code 1');
      }
      return 'ZE184226B<<<<<10';
    },
  };

  const lines = await splitLineOcr(Buffer.from('image'), 100, 100, deps);

  assert.deepEqual(lines, ['', 'ZE184226B<<<<<10']);
});

test('splitLineOcr never rejects even when both halves fail for different reasons', async () => {
  let call = 0;
  const deps: SplitLineOcrDependencies = {
    cropRegion: async (_buffer, top, height) => Buffer.from(`crop-${top}-${height}`),
    runTesseractOcr: async () => {
      call += 1;
      if (call === 1) throw new Error('Local OCR (tesseract) exited with code null (terminated by signal SIGFPE)');
      throw new Error('Local OCR (tesseract) exited with code 1: some stderr detail');
    },
  };

  await assert.doesNotReject(() => splitLineOcr(Buffer.from('image'), 100, 100, deps));
  const lines = await splitLineOcr(Buffer.from('image'), 100, 100, deps);
  assert.deepEqual(lines, ['', '']);
});

test('splitLineOcr still launches both halves’ OCR concurrently after switching to Promise.allSettled', async () => {
  let concurrent = 0;
  let maxConcurrent = 0;

  const deps: SplitLineOcrDependencies = {
    cropRegion: async (_buffer, top, height) => Buffer.from(`crop-${top}-${height}`),
    runTesseractOcr: async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 10));
      concurrent -= 1;
      return 'TEXT';
    },
  };

  await splitLineOcr(Buffer.from('image'), 100, 100, deps);

  assert.strictEqual(maxConcurrent, 2, 'both halves’ OCR calls must still run concurrently, not sequentially');
});

test('splitLineOcr still crops the top and bottom halves via a single Promise.all (crop behavior unchanged)', async () => {
  const cropCalls: Array<{ top: number; height: number }> = [];
  const deps: SplitLineOcrDependencies = {
    cropRegion: async (_buffer, top, height) => {
      cropCalls.push({ top, height });
      return Buffer.from(`crop-${top}-${height}`);
    },
    runTesseractOcr: async () => 'TEXT',
  };

  await splitLineOcr(Buffer.from('image'), 100, 100, deps);

  assert.deepEqual(cropCalls, [
    { top: 100, height: 50 },
    { top: 150, height: 50 },
  ]);
});
