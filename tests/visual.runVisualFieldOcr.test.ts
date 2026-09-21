import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runVisualFieldOcr, type RunVisualFieldOcrDependencies } from '../src/ocr/visual/runVisualFieldOcr.js';

function buildDeps(overrides: Partial<RunVisualFieldOcrDependencies> = {}): RunVisualFieldOcrDependencies {
  return {
    locateVisualZone: async (buffer) => buffer,
    runTesseractOcr: async () => '',
    ...overrides,
  };
}

test('runVisualFieldOcr resolves the one unexplained date from OCR text (end to end, mocked crop+OCR)', async () => {
  const deps = buildDeps({
    runTesseractOcr: async () => 'DATE OF ISSUE 15 JAN 2020 DATE OF EXPIRY 15 JAN 2030',
  });

  const result = await runVisualFieldOcr(Buffer.from('fake-image'), ['1990-05-12', '2030-01-15'], deps);

  assert.equal(result, '2020-01-15');
});

test('runVisualFieldOcr passes non-whitelisted OCR options so general text (not just MRZ alphabet) can be read', async () => {
  let receivedOptions: unknown;
  const deps = buildDeps({
    runTesseractOcr: async (_buffer, options) => {
      receivedOptions = options;
      return '15 JAN 2020';
    },
  });

  await runVisualFieldOcr(Buffer.from('fake-image'), ['1990-05-12'], deps);

  assert.equal((receivedOptions as { useWhitelist?: boolean } | undefined)?.useWhitelist, false);
});

test('runVisualFieldOcr returns null and never throws when locateVisualZone fails', async () => {
  const deps = buildDeps({
    locateVisualZone: async () => {
      throw new Error('Could not read image dimensions');
    },
  });

  const result = await runVisualFieldOcr(Buffer.from('fake-image'), ['1990-05-12', '2030-01-15'], deps);

  assert.equal(result, null);
});

test('runVisualFieldOcr returns null and never throws when runTesseractOcr fails', async () => {
  const deps = buildDeps({
    runTesseractOcr: async () => {
      throw new Error('Failed to start local OCR (tesseract): spawn tesseract ENOENT');
    },
  });

  const result = await runVisualFieldOcr(Buffer.from('fake-image'), ['1990-05-12', '2030-01-15'], deps);

  assert.equal(result, null);
});

test('runVisualFieldOcr returns null when no unambiguous candidate can be inferred', async () => {
  const deps = buildDeps({
    runTesseractOcr: async () => 'NO DATES HERE AT ALL',
  });

  const result = await runVisualFieldOcr(Buffer.from('fake-image'), ['1990-05-12', '2030-01-15'], deps);

  assert.equal(result, null);
});

test('runVisualFieldOcr returns null when known dates are empty (nothing to eliminate against)', async () => {
  const deps = buildDeps({
    runTesseractOcr: async () => '15 JAN 2020',
  });

  const result = await runVisualFieldOcr(Buffer.from('fake-image'), [], deps);

  assert.equal(result, null);
});

test('runVisualFieldOcr logs only counts/booleans, never the OCR text or actual date values', async () => {
  const originalLog = console.log;
  const logLines: string[] = [];
  console.log = (...args: unknown[]) => {
    logLines.push(args.map(String).join(' '));
  };

  try {
    const deps = buildDeps({
      runTesseractOcr: async () => 'DATE OF ISSUE 15 JAN 2020 DATE OF EXPIRY 15 JAN 2030 SUPER SECRET PASSPORT TEXT',
    });

    await runVisualFieldOcr(Buffer.from('fake-image'), ['1990-05-12', '2030-01-15'], deps);
  } finally {
    console.log = originalLog;
  }

  const combined = logLines.join('\n');
  assert.ok(!combined.includes('2020-01-15'), 'log must not contain the resolved date value');
  assert.ok(!combined.includes('SUPER SECRET PASSPORT TEXT'), 'log must not contain OCR text content');
  assert.ok(!combined.includes('JAN'), 'log must not contain any raw OCR-extracted date text');
});
