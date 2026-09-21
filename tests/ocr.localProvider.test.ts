import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLocalProvider, type LocalProviderDependencies } from '../src/ocr/providers/localProvider.js';
import type { MrzSearchResult } from '../src/ocr/mrz/searchMrzLines.js';
import { parseAndValidateMrz } from '../src/ocr/mrz/parseAndValidateMrz.js';

const VALID_SPECIMEN_LINES = ['P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<', 'L898902C36UTO7408122F1204159ZE184226B<<<<<10'];

function validSearchResult(): MrzSearchResult {
  const parsed = parseAndValidateMrz(VALID_SPECIMEN_LINES);
  assert.ok(parsed, 'specimen MRZ must parse for these tests to be meaningful');
  return { lines: VALID_SPECIMEN_LINES, parsed };
}

async function captureLogs(run: () => Promise<void>): Promise<string[]> {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  try {
    await run();
  } finally {
    console.log = originalLog;
  }
  return lines;
}

function pipelineLogLines(lines: string[]): string[] {
  return lines.filter((line) => line.startsWith('[mrz-pipeline]'));
}

function buildDeps(overrides: Partial<LocalProviderDependencies> = {}): {
  deps: LocalProviderDependencies;
  calls: { search: number; locate: number; crop: number; ocr: number; dims: number; visual: number };
} {
  const calls = { search: 0, locate: 0, crop: 0, ocr: 0, dims: 0, visual: 0 };
  const deps: LocalProviderDependencies = {
    searchMrzLines: async () => {
      calls.search += 1;
      return null;
    },
    locateMrzRegion: async (buffer) => {
      calls.locate += 1;
      return buffer;
    },
    cropRegion: async (buffer) => {
      calls.crop += 1;
      return buffer;
    },
    runTesseractOcr: async () => {
      calls.ocr += 1;
      return 'not an mrz';
    },
    getImageDimensions: async () => {
      calls.dims += 1;
      return { width: 900, height: 1200 };
    },
    runVisualFieldOcr: async () => {
      calls.visual += 1;
      return null;
    },
    ...overrides,
  };
  return { deps, calls };
}

test('local provider is named "local" and never touches Anthropic', () => {
  const { deps } = buildDeps();
  assert.equal(createLocalProvider(deps).name, 'local');
});

test('local provider returns the search result immediately when the candidate search succeeds (no fallback calls)', async () => {
  const { deps, calls } = buildDeps({
    searchMrzLines: async () => {
      calls.search += 1;
      return validSearchResult();
    },
  });
  const provider = createLocalProvider(deps);

  const result = await provider.extract(Buffer.from('fake-image-bytes'), 'image/jpeg');

  assert.equal(result.surname.value, 'ERIKSSON');
  assert.equal(calls.search, 1);
  assert.equal(calls.locate, 0, 'must not fall back once search succeeds');
  assert.equal(calls.ocr, 0, 'must not run any fallback OCR once search succeeds');
});

test('local provider falls back to the plain fixed crop when search finds nothing', async () => {
  const { deps, calls } = buildDeps({
    runTesseractOcr: async () => {
      calls.ocr += 1;
      return VALID_SPECIMEN_LINES.join('\n');
    },
  });
  const provider = createLocalProvider(deps);

  const result = await provider.extract(Buffer.from('fake-image-bytes'), 'image/jpeg');

  assert.equal(result.surname.value, 'ERIKSSON');
  assert.equal(calls.search, 1);
  assert.equal(calls.locate, 1, 'fallback stage 2 must use the original fixed crop');
  assert.equal(calls.ocr, 1, 'must stop at stage 2 — never run binarized/split fallbacks once stage 2 succeeds');
});

test('local provider tries the binarized fallback when the plain fallback crop does not parse', async () => {
  const { deps, calls } = buildDeps({
    runTesseractOcr: async (_buffer, options) => {
      calls.ocr += 1;
      // Plain (stage 2) attempt returns garbage; binarized (stage 3) succeeds.
      if (calls.ocr === 1) return 'not an mrz';
      return VALID_SPECIMEN_LINES.join('\n');
    },
  });
  const provider = createLocalProvider(deps);

  const result = await provider.extract(Buffer.from('fake-image-bytes'), 'image/jpeg');

  assert.equal(result.surname.value, 'ERIKSSON');
  assert.equal(calls.ocr, 2, 'stage 2 (plain) then stage 3 (binarized) — must stop there');
  assert.equal(calls.dims, 1);
});

test('local provider tries split-line OCR as the last fallback stage', async () => {
  const { deps, calls } = buildDeps({
    runTesseractOcr: async () => {
      calls.ocr += 1;
      // Every combined-block attempt (stage 2 and 3) fails; only the
      // split-line calls (stage 4) return usable single-line text.
      if (calls.ocr <= 2) return 'not an mrz';
      return calls.ocr === 3 ? VALID_SPECIMEN_LINES[0]! : VALID_SPECIMEN_LINES[1]!;
    },
  });
  const provider = createLocalProvider(deps);

  const result = await provider.extract(Buffer.from('fake-image-bytes'), 'image/jpeg');

  assert.equal(result.surname.value, 'ERIKSSON');
  assert.equal(calls.ocr, 4, 'stage 2 + stage 3 + two split-line (stage 4) calls, then stop');
});

test('local provider returns a low-confidence, all-null result when every stage fails (never throws, never guesses)', async () => {
  const { deps } = buildDeps();
  const provider = createLocalProvider(deps);

  const result = await provider.extract(Buffer.from('fake-image-bytes'), 'image/jpeg');

  assert.equal(result.overallConfidence, 'low');
  assert.equal(result.surname.value, null);
  assert.equal(result.passportNumber.value, null);
});

test('local provider propagates a crop-dimension failure (e.g. corrupt/unreadable image) from the fallback stage', async () => {
  const { deps } = buildDeps({
    locateMrzRegion: async () => {
      throw new Error('Could not read image dimensions for MRZ region crop');
    },
  });

  const provider = createLocalProvider(deps);

  await assert.rejects(
    () => provider.extract(Buffer.from('not-an-image'), 'image/jpeg'),
    /Could not read image dimensions/,
  );
});

test('local provider propagates a Tesseract failure (e.g. binary not installed)', async () => {
  const { deps } = buildDeps({
    runTesseractOcr: async () => {
      throw new Error('Failed to start local OCR (tesseract): spawn tesseract ENOENT');
    },
  });

  const provider = createLocalProvider(deps);

  await assert.rejects(() => provider.extract(Buffer.from('fake-image-bytes'), 'image/jpeg'), /Failed to start local OCR/);
});

test('local provider fills passportIssueDate from the visual enrichment step after a successful MRZ result, passing the MRZ-derived dates as "known"', async () => {
  let capturedKnown: string[] | undefined;
  const { deps, calls } = buildDeps({
    searchMrzLines: async () => validSearchResult(),
    runVisualFieldOcr: async (_buffer, known) => {
      calls.visual += 1;
      capturedKnown = known;
      return '2020-01-15';
    },
  });
  const provider = createLocalProvider(deps);

  const result = await provider.extract(Buffer.from('fake-image-bytes'), 'image/jpeg');

  assert.equal(result.surname.value, 'ERIKSSON', 'must not disturb fields the MRZ pipeline already produced');
  assert.equal(result.passportIssueDate.value, '2020-01-15');
  assert.equal(result.passportIssueDate.confidence, 'medium');
  assert.equal(calls.visual, 1);
  assert.ok(capturedKnown, 'runVisualFieldOcr must be called with the known MRZ dates');
  assert.equal(capturedKnown?.length, 2, 'both dateOfBirth and passportExpiryDate must be passed as known anchors');
  assert.ok(capturedKnown?.every((value) => typeof value === 'string' && value.length > 0));
});

test('local provider leaves passportIssueDate null when the visual enrichment step finds no unambiguous date', async () => {
  const { deps, calls } = buildDeps({
    searchMrzLines: async () => validSearchResult(),
    runVisualFieldOcr: async () => {
      calls.visual += 1;
      return null;
    },
  });
  const provider = createLocalProvider(deps);

  const result = await provider.extract(Buffer.from('fake-image-bytes'), 'image/jpeg');

  assert.equal(result.passportIssueDate.value, null);
  assert.equal(result.passportIssueDate.confidence, null);
  assert.equal(calls.visual, 1);
});

test('local provider never throws when the visual enrichment step fails, and returns the MRZ result unchanged', async () => {
  const { deps } = buildDeps({
    searchMrzLines: async () => validSearchResult(),
    runVisualFieldOcr: async () => {
      throw new Error('unexpected visual OCR failure');
    },
  });
  const provider = createLocalProvider(deps);

  const result = await provider.extract(Buffer.from('fake-image-bytes'), 'image/jpeg');

  assert.equal(result.surname.value, 'ERIKSSON');
  assert.equal(result.passportIssueDate.value, null);
});

test('local provider does not call the visual enrichment step when every MRZ stage fails', async () => {
  const { deps, calls } = buildDeps();
  const provider = createLocalProvider(deps);

  await provider.extract(Buffer.from('fake-image-bytes'), 'image/jpeg');

  assert.equal(calls.visual, 0, 'no successful MRZ result to enrich — visual OCR must not run');
});

test('local provider logs only winner=search (no fallback-stage attempt logs) when the search stage succeeds', async () => {
  const { deps } = buildDeps({ searchMrzLines: async () => validSearchResult() });
  const provider = createLocalProvider(deps);

  const logs = await captureLogs(() => provider.extract(Buffer.from('fake-image-bytes'), 'image/jpeg').then(() => {}));

  assert.deepEqual(pipelineLogLines(logs), ['[mrz-pipeline] winner=search']);
});

test('local provider logs the fallback-plain attempt (structural fields only) and winner=fallback-plain when stage 2 succeeds', async () => {
  const { deps } = buildDeps({
    runTesseractOcr: async () => VALID_SPECIMEN_LINES.join('\n'),
  });
  const provider = createLocalProvider(deps);

  const logs = await captureLogs(() => provider.extract(Buffer.from('fake-image-bytes'), 'image/jpeg').then(() => {}));
  const expectedLengths = VALID_SPECIMEN_LINES.map((line) => line.length).join(',');

  assert.deepEqual(pipelineLogLines(logs), [
    `[mrz-pipeline] stage=fallback-plain attempt=2 lineCount=2 lengths=[${expectedLengths}] parseSuccess=true`,
    '[mrz-pipeline] winner=fallback-plain',
  ]);
});

test('local provider logs a failed fallback-plain attempt, then the fallback-binarized attempt and winner when stage 3 succeeds', async () => {
  let ocrCallCount = 0;
  const { deps } = buildDeps({
    runTesseractOcr: async () => {
      ocrCallCount += 1;
      return ocrCallCount === 1 ? 'not an mrz' : VALID_SPECIMEN_LINES.join('\n');
    },
  });
  const provider = createLocalProvider(deps);

  const logs = await captureLogs(() => provider.extract(Buffer.from('fake-image-bytes'), 'image/jpeg').then(() => {}));
  const expectedLengths = VALID_SPECIMEN_LINES.map((line) => line.length).join(',');

  assert.deepEqual(pipelineLogLines(logs), [
    '[mrz-pipeline] stage=fallback-plain attempt=2 lineCount=1 lengths=[8] parseSuccess=false',
    `[mrz-pipeline] stage=fallback-binarized attempt=3 lineCount=2 lengths=[${expectedLengths}] parseSuccess=true`,
    '[mrz-pipeline] winner=fallback-binarized',
  ]);
});

test('local provider logs failed fallback-plain and fallback-binarized attempts, then the fallback-split attempt and winner when stage 4 succeeds', async () => {
  let ocrCallCount = 0;
  const { deps } = buildDeps({
    runTesseractOcr: async () => {
      ocrCallCount += 1;
      if (ocrCallCount <= 2) return 'not an mrz';
      return ocrCallCount === 3 ? VALID_SPECIMEN_LINES[0]! : VALID_SPECIMEN_LINES[1]!;
    },
  });
  const provider = createLocalProvider(deps);

  const logs = await captureLogs(() => provider.extract(Buffer.from('fake-image-bytes'), 'image/jpeg').then(() => {}));
  const expectedLengths = VALID_SPECIMEN_LINES.map((line) => line.length).join(',');

  assert.deepEqual(pipelineLogLines(logs), [
    '[mrz-pipeline] stage=fallback-plain attempt=2 lineCount=1 lengths=[8] parseSuccess=false',
    '[mrz-pipeline] stage=fallback-binarized attempt=3 lineCount=1 lengths=[8] parseSuccess=false',
    `[mrz-pipeline] stage=fallback-split attempt=4 lineCount=2 lengths=[${expectedLengths}] parseSuccess=true`,
    '[mrz-pipeline] winner=fallback-split',
  ]);
});

test('local provider logs every fallback attempt as failed and winner=none when the whole pipeline fails', async () => {
  const { deps } = buildDeps();
  const provider = createLocalProvider(deps);

  const logs = await captureLogs(() => provider.extract(Buffer.from('fake-image-bytes'), 'image/jpeg').then(() => {}));

  assert.deepEqual(pipelineLogLines(logs), [
    '[mrz-pipeline] stage=fallback-plain attempt=2 lineCount=1 lengths=[8] parseSuccess=false',
    '[mrz-pipeline] stage=fallback-binarized attempt=3 lineCount=1 lengths=[8] parseSuccess=false',
    '[mrz-pipeline] stage=fallback-split attempt=4 lineCount=2 lengths=[8,8] parseSuccess=false',
    '[mrz-pipeline] winner=none',
  ]);
});

test('local provider pipeline logs never contain OCR text or passport field values — only structural counts/booleans', async () => {
  const { deps } = buildDeps({
    runTesseractOcr: async () => VALID_SPECIMEN_LINES.join('\n'),
  });
  const provider = createLocalProvider(deps);

  const logs = await captureLogs(() => provider.extract(Buffer.from('fake-image-bytes'), 'image/jpeg').then(() => {}));
  const combined = pipelineLogLines(logs).join('\n');

  assert.ok(!combined.includes('ERIKSSON'), 'pipeline log must not contain the surname');
  assert.ok(!combined.includes('L898902C3'), 'pipeline log must not contain the passport number');
  assert.ok(!combined.includes(VALID_SPECIMEN_LINES[0]!), 'pipeline log must not contain the raw MRZ line');
  assert.ok(!combined.includes(VALID_SPECIMEN_LINES[1]!), 'pipeline log must not contain the raw MRZ line');
});
