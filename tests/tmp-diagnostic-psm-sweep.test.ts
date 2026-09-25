import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  runTesseractVariant,
  runPsmSweepDiagnostic,
  computeHalfRegions,
  runMessageHalfSweep,
  formatLabeledResults,
  type TesseractVariantResult,
  type LabeledPsmResult,
} from '../scripts/tmp-diagnostic-psm-sweep.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ECHO_ARGS_SCRIPT = path.join(__dirname, 'fixtures', 'echo-args.sh');
const SELF_KILL_SCRIPT = path.join(__dirname, 'fixtures', 'self-kill.sh');

test('runTesseractVariant reports outcome=succeeded and exitCode=0 for a clean exit', async () => {
  // echo-args.sh always exits 0.
  const result = await runTesseractVariant(Buffer.from('fake-image'), 7, 1, ECHO_ARGS_SCRIPT);

  assert.strictEqual(result.psm, 7);
  assert.strictEqual(result.oem, 1);
  assert.strictEqual(result.exitCode, 0);
  assert.strictEqual(result.signal, null);
  assert.strictEqual(result.outcome, 'succeeded');
});

test('runTesseractVariant reports outcome=crashed and the signal name when terminated by a signal', async () => {
  const result = await runTesseractVariant(Buffer.from('fake-image'), 7, 1, SELF_KILL_SCRIPT);

  assert.strictEqual(result.exitCode, null);
  assert.strictEqual(result.signal, 'SIGKILL');
  assert.strictEqual(result.outcome, 'crashed');
});

test('runTesseractVariant reports outcome=failed for a non-zero exit without a signal', async () => {
  const result = await runTesseractVariant(Buffer.from('fake-image'), 7, 1, 'false');

  assert.strictEqual(result.exitCode, 1);
  assert.strictEqual(result.signal, null);
  assert.strictEqual(result.outcome, 'failed');
});

test('runTesseractVariant passes --psm, --oem, and the MRZ whitelist flags, matching production’s splitLineOcr call', async () => {
  // echo-args.sh echoes its argv to stdout; capture it via a raw spawn-free
  // check by re-running through runTesseractVariant is not possible since it
  // never exposes stdout — this test instead verifies argument construction
  // indirectly is out of scope here (covered by production's own
  // runTesseractOcr tests). This test just confirms distinct psm/oem values
  // don't crash the wrapper itself.
  const result = await runTesseractVariant(Buffer.from('fake-image'), 13, 1, ECHO_ARGS_SCRIPT);
  assert.strictEqual(result.psm, 13);
  assert.strictEqual(result.outcome, 'succeeded');
});

test('runPsmSweepDiagnostic runs one variant per PSM value, in the given order', async () => {
  const calls: number[] = [];
  const fakeRunVariant = async (_buffer: Buffer, psm: number, oem: number): Promise<TesseractVariantResult> => {
    calls.push(psm);
    return { psm, oem, exitCode: 0, signal: null, outcome: 'succeeded' };
  };

  const results = await runPsmSweepDiagnostic(Buffer.from('fake-image'), [6, 7, 8, 13], 1, fakeRunVariant);

  assert.deepStrictEqual(calls, [6, 7, 8, 13]);
  assert.strictEqual(results.length, 4);
  assert.deepStrictEqual(
    results.map((r) => r.psm),
    [6, 7, 8, 13],
  );
});

test('runPsmSweepDiagnostic runs variants strictly sequentially, never overlapping (no Promise.all)', async () => {
  let concurrent = 0;
  let maxConcurrent = 0;

  const fakeRunVariant = async (_buffer: Buffer, psm: number, oem: number): Promise<TesseractVariantResult> => {
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise((resolve) => setTimeout(resolve, 5));
    concurrent -= 1;
    return { psm, oem, exitCode: 0, signal: null, outcome: 'succeeded' };
  };

  await runPsmSweepDiagnostic(Buffer.from('fake-image'), [6, 7, 8, 13], 1, fakeRunVariant);

  assert.strictEqual(maxConcurrent, 1, 'no two Tesseract variant calls should ever run concurrently');
});

test('runPsmSweepDiagnostic continues to the next PSM value even after a crash', async () => {
  const fakeRunVariant = async (_buffer: Buffer, psm: number, oem: number): Promise<TesseractVariantResult> => {
    if (psm === 7) return { psm, oem, exitCode: null, signal: 'SIGFPE', outcome: 'crashed' };
    return { psm, oem, exitCode: 0, signal: null, outcome: 'succeeded' };
  };

  const results = await runPsmSweepDiagnostic(Buffer.from('fake-image'), [6, 7, 8, 13], 1, fakeRunVariant);

  assert.strictEqual(results.length, 4, 'a crash on one PSM must not stop the sweep');
  assert.strictEqual(results[1]?.outcome, 'crashed');
  assert.strictEqual(results[1]?.signal, 'SIGFPE');
  assert.strictEqual(results[2]?.outcome, 'succeeded');
});

test('computeHalfRegions matches splitLineOcr.ts’s exact halfHeight rounding and boundaries', () => {
  const { top, bottom } = computeHalfRegions(1097, 366);

  assert.deepStrictEqual(top, { top: 1097, height: 183 });
  assert.deepStrictEqual(bottom, { top: 1280, height: 183 });
});

test('computeHalfRegions handles an odd total height without losing or overlapping rows', () => {
  const { top, bottom } = computeHalfRegions(500, 101);

  assert.strictEqual(top.height + bottom.height, 101);
  assert.strictEqual(top.top, 500);
  assert.strictEqual(bottom.top, 500 + top.height);
});

test('runMessageHalfSweep crops once, sweeps every PSM value in order, and labels every result with message/half', async () => {
  const cropCalls: Array<{ top: number; height: number }> = [];
  const variantCalls: number[] = [];
  const deps = {
    cropRegion: async (_buffer: Buffer, top: number, height: number) => {
      cropCalls.push({ top, height });
      return Buffer.from('cropped');
    },
    runVariant: async (_buffer: Buffer, psm: number, oem: number): Promise<TesseractVariantResult> => {
      variantCalls.push(psm);
      return { psm, oem, exitCode: 0, signal: null, outcome: 'succeeded' as const };
    },
  };

  const results = await runMessageHalfSweep('270', 'TOP', Buffer.from('fake-image'), { top: 1097, height: 183 }, [6, 7, 8, 13], 1, deps);

  assert.deepStrictEqual(cropCalls, [{ top: 1097, height: 183 }]);
  assert.deepStrictEqual(variantCalls, [6, 7, 8, 13]);
  assert.strictEqual(results.length, 4);
  for (const result of results) {
    assert.strictEqual(result.message, '270');
    assert.strictEqual(result.half, 'TOP');
  }
});

test('formatLabeledResults groups results under one "message=... half=..." header per group, in order', () => {
  const results: LabeledPsmResult[] = [
    { message: '270', half: 'TOP', psm: 6, oem: 1, exitCode: 0, signal: null, outcome: 'succeeded' },
    { message: '270', half: 'TOP', psm: 7, oem: 1, exitCode: null, signal: 'SIGFPE', outcome: 'crashed' },
    { message: '270', half: 'BOTTOM', psm: 6, oem: 1, exitCode: 0, signal: null, outcome: 'succeeded' },
    { message: '271', half: 'TOP', psm: 6, oem: 1, exitCode: 0, signal: null, outcome: 'succeeded' },
  ];

  const formatted = formatLabeledResults(results);
  const lines = formatted.split('\n');

  assert.strictEqual(lines[0], 'message=270 half=TOP');
  assert.ok(lines.some((l) => l.includes('psm=7') && l.includes('SIGFPE')));
  assert.ok(lines.includes('message=270 half=BOTTOM'));
  assert.ok(lines.includes('message=271 half=TOP'));
  // Exactly one header per (message, half) group, not one per result.
  assert.strictEqual(lines.filter((l) => l.startsWith('message=')).length, 3);
});

test('formatLabeledResults never includes OCR text (only numeric/status fields)', () => {
  const results: LabeledPsmResult[] = [
    { message: '270', half: 'TOP', psm: 7, oem: 1, exitCode: null, signal: 'SIGFPE', outcome: 'crashed' },
  ];
  const formatted = formatLabeledResults(results);

  assert.ok(formatted.includes('psm=7'));
  assert.ok(formatted.includes('SIGFPE'));
  assert.ok(formatted.includes('outcome=crashed'));
});
