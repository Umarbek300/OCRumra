import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLocalProvider, type LocalProviderDependencies } from '../src/ocr/providers/localProvider.js';
import type { MrzSearchResult } from '../src/ocr/mrz/searchMrzLines.js';
import { parseAndValidateMrz } from '../src/ocr/mrz/parseAndValidateMrz.js';
import { findMrzCandidateRegions } from '../src/ocr/mrz/findMrzCandidateRegions.js';
import { ENHANCED_FALLBACK_ATTEMPTS } from '../src/ocr/mrz/enhancedFallbackAttempts.js';
import { DESKEW_FALLBACK_ATTEMPTS, TRIM_FALLBACK_ATTEMPTS } from '../src/ocr/mrz/geometryFallbackAttempts.js';
import type { CropRegionOptions } from '../src/ocr/mrz/cropRegion.js';

// Fixed test image size -> 3 deterministic candidates (tightest-first):
// { top: 900, height: 300 }, { top: 816, height: 384 }, { top: 720, height: 480 }.
const IMAGE_WIDTH = 900;
const IMAGE_HEIGHT = 1200;
const CANDIDATES = findMrzCandidateRegions(IMAGE_WIDTH, IMAGE_HEIGHT);

// Per candidate: 1 (binarized) + 2 (split, two half-crops) + enhanced + localized + deskew.
const OCR_CALLS_PER_CANDIDATE = 1 + 2 + ENHANCED_FALLBACK_ATTEMPTS.length + TRIM_FALLBACK_ATTEMPTS.length + DESKEW_FALLBACK_ATTEMPTS.length;
const ALL_BOUNDED_OCR_CALLS = OCR_CALLS_PER_CANDIDATE * CANDIDATES.length;
// Logged pipeline attempts per candidate (split's 2 OCR calls count as one
// logged "fallback-split" attempt, matching the existing single-log-line
// convention for that stage).
const LOGGED_ATTEMPTS_PER_CANDIDATE = 1 + 1 + ENHANCED_FALLBACK_ATTEMPTS.length + TRIM_FALLBACK_ATTEMPTS.length + DESKEW_FALLBACK_ATTEMPTS.length;

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
  calls: { search: number; crop: number; ocr: number; dims: number; visual: number };
  cropCalls: Array<{ top: number; height: number; options: CropRegionOptions | undefined }>;
} {
  const calls = { search: 0, crop: 0, ocr: 0, dims: 0, visual: 0 };
  const cropCalls: Array<{ top: number; height: number; options: CropRegionOptions | undefined }> = [];
  const deps: LocalProviderDependencies = {
    searchMrzLines: async () => {
      calls.search += 1;
      return null;
    },
    cropRegion: async (buffer, top, height, options) => {
      calls.crop += 1;
      cropCalls.push({ top, height, options });
      return buffer;
    },
    runTesseractOcr: async () => {
      calls.ocr += 1;
      return 'not an mrz';
    },
    getImageDimensions: async () => {
      calls.dims += 1;
      return { width: IMAGE_WIDTH, height: IMAGE_HEIGHT };
    },
    runVisualFieldOcr: async () => {
      calls.visual += 1;
      return null;
    },
    ...overrides,
  };
  return { deps, calls, cropCalls };
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
  assert.equal(calls.ocr, 0, 'must not run any fallback OCR once search succeeds');
});

test('local provider tries candidate 0 (tightest) binarized fallback first when search finds nothing', async () => {
  const { deps, calls, cropCalls } = buildDeps({
    runTesseractOcr: async () => {
      calls.ocr += 1;
      return VALID_SPECIMEN_LINES.join('\n');
    },
  });
  const provider = createLocalProvider(deps);

  const result = await provider.extract(Buffer.from('fake-image-bytes'), 'image/jpeg');

  assert.equal(result.surname.value, 'ERIKSSON');
  assert.equal(calls.ocr, 1, 'must stop at the first (binarized) attempt on candidate 0');
  assert.equal(cropCalls[0]!.top, CANDIDATES[0]!.top);
  assert.equal(cropCalls[0]!.height, CANDIDATES[0]!.height);
  assert.equal(cropCalls[0]!.options?.binarize, true);
});

test('local provider tries the split-line stage on the same candidate when its binarized attempt fails', async () => {
  const { deps, calls } = buildDeps({
    runTesseractOcr: async () => {
      calls.ocr += 1;
      // Binarized (call 1) fails; both split halves (calls 2-3) succeed.
      if (calls.ocr === 1) return 'not an mrz';
      return calls.ocr === 2 ? VALID_SPECIMEN_LINES[0]! : VALID_SPECIMEN_LINES[1]!;
    },
  });
  const provider = createLocalProvider(deps);

  const result = await provider.extract(Buffer.from('fake-image-bytes'), 'image/jpeg');

  assert.equal(result.surname.value, 'ERIKSSON');
  assert.equal(calls.ocr, 3, 'binarized (1) + split (2) — must stop there');
  assert.equal(calls.dims, 1);
});

test('local provider tries enhanced/localized/deskew on candidate 0 before ever moving to candidate 1', async () => {
  const { deps, calls, cropCalls } = buildDeps({
    runTesseractOcr: async () => {
      calls.ocr += 1;
      // Only the very last attempt on candidate 0 (deskew, last angle) succeeds.
      if (calls.ocr < OCR_CALLS_PER_CANDIDATE) return 'not an mrz';
      return VALID_SPECIMEN_LINES.join('\n');
    },
  });
  const provider = createLocalProvider(deps);

  const result = await provider.extract(Buffer.from('fake-image-bytes'), 'image/jpeg');

  assert.equal(result.surname.value, 'ERIKSSON');
  assert.equal(calls.ocr, OCR_CALLS_PER_CANDIDATE, 'must exhaust every stage on candidate 0 before succeeding');
  // Every crop call so far must stay within candidate 0's vertical span —
  // split-line OCR crops its top/bottom halves separately, so top/height
  // vary within the region rather than exactly matching the full candidate.
  const candidate0 = CANDIDATES[0]!;
  assert.ok(
    cropCalls.every(
      (call) => call.top >= candidate0.top && call.top + call.height <= candidate0.top + candidate0.height,
    ),
  );
});

test('local provider moves to candidate 1 (next fraction) only after every stage on candidate 0 has failed', async () => {
  const { deps, calls, cropCalls } = buildDeps({
    runTesseractOcr: async () => {
      calls.ocr += 1;
      // Every attempt on candidate 0 fails; candidate 1's first (binarized) attempt succeeds.
      if (calls.ocr <= OCR_CALLS_PER_CANDIDATE) return 'not an mrz';
      return VALID_SPECIMEN_LINES.join('\n');
    },
  });
  const provider = createLocalProvider(deps);

  const result = await provider.extract(Buffer.from('fake-image-bytes'), 'image/jpeg');

  assert.equal(result.surname.value, 'ERIKSSON');
  assert.equal(calls.ocr, OCR_CALLS_PER_CANDIDATE + 1, 'all of candidate 0 + candidate 1\'s first attempt');

  const winningCropCall = cropCalls[cropCalls.length - 1]!;
  assert.equal(winningCropCall.top, CANDIDATES[1]!.top, 'must have moved to candidate 1\'s geometry');
  assert.equal(winningCropCall.height, CANDIDATES[1]!.height);
});

test('local provider tries all 3 candidates, in tightest-first order, before giving up', async () => {
  const { deps, calls } = buildDeps();
  const provider = createLocalProvider(deps);

  const result = await provider.extract(Buffer.from('fake-image-bytes'), 'image/jpeg');

  assert.equal(result.overallConfidence, 'low');
  assert.equal(result.surname.value, null);
  assert.equal(calls.ocr, ALL_BOUNDED_OCR_CALLS, 'must try every stage on every candidate exactly once, then stop');
});

test('local provider requests LSTM-only OCR engine mode (--oem 1) on every fallback-stage OCR call', async () => {
  const ocrOptions: Array<{ psm?: number; oem?: number }> = [];
  const { deps } = buildDeps({
    runTesseractOcr: async (_buffer, options) => {
      ocrOptions.push({ psm: options?.psm, oem: options?.oem });
      return 'not an mrz';
    },
  });
  const provider = createLocalProvider(deps);

  await provider.extract(Buffer.from('fake-image-bytes'), 'image/jpeg');

  assert.equal(ocrOptions.length, ALL_BOUNDED_OCR_CALLS);
  assert.ok(ocrOptions.every((options) => options.oem === 1), 'every fallback-stage OCR call must request oem=1');
});

test('local provider propagates a dimension-read failure (e.g. corrupt/unreadable image)', async () => {
  const { deps } = buildDeps({
    getImageDimensions: async () => {
      throw new Error('Could not read image dimensions');
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

test('local provider fills passportIssueDate from the visual enrichment step after a successful MRZ result', async () => {
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

  assert.equal(result.surname.value, 'ERIKSSON');
  assert.equal(result.passportIssueDate.value, '2020-01-15');
  assert.equal(result.passportIssueDate.confidence, 'medium');
  assert.equal(calls.visual, 1);
  assert.ok(capturedKnown && capturedKnown.length === 2);
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

test('local provider logs each fallback attempt with its candidate index, stage, and structural result only', async () => {
  const { deps } = buildDeps({
    runTesseractOcr: async () => VALID_SPECIMEN_LINES.join('\n'),
  });
  const provider = createLocalProvider(deps);

  const logs = await captureLogs(() => provider.extract(Buffer.from('fake-image-bytes'), 'image/jpeg').then(() => {}));
  const lines = pipelineLogLines(logs);

  assert.equal(lines.length, 2, 'one attempt log line + one winner line');
  assert.match(lines[0]!, /candidate=0/);
  assert.match(lines[0]!, /stage=fallback-binarized/);
  assert.match(lines[0]!, /parseSuccess=true/);
  assert.equal(lines[1], '[mrz-pipeline] winner=fallback-binarized');
});

test('local provider logs every attempt across every candidate (and no more) when the whole pipeline fails', async () => {
  const { deps } = buildDeps();
  const provider = createLocalProvider(deps);

  const logs = await captureLogs(() => provider.extract(Buffer.from('fake-image-bytes'), 'image/jpeg').then(() => {}));
  const lines = pipelineLogLines(logs);

  // One logged attempt per stage per candidate, plus the final winner=none line.
  assert.equal(lines.length, LOGGED_ATTEMPTS_PER_CANDIDATE * CANDIDATES.length + 1);
  assert.equal(lines[lines.length - 1], '[mrz-pipeline] winner=none');
  for (let candidateIndex = 0; candidateIndex < CANDIDATES.length; candidateIndex++) {
    const candidateLines = lines.filter((line) => line.includes(`candidate=${candidateIndex}`));
    assert.equal(candidateLines.length, LOGGED_ATTEMPTS_PER_CANDIDATE, `candidate ${candidateIndex} must log every stage exactly once`);
  }
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

test('local provider uses each configured (scale, threshold) enhanced combination in order, per candidate', async () => {
  const { deps, cropCalls } = buildDeps();
  const provider = createLocalProvider(deps);

  await provider.extract(Buffer.from('fake-image-bytes'), 'image/jpeg');

  // Within candidate 0: crop calls 0=binarized, 1-2=split, 3..10=enhanced.
  const enhancedStart = 1 + 2;
  const enhancedCropCalls = cropCalls.slice(enhancedStart, enhancedStart + ENHANCED_FALLBACK_ATTEMPTS.length);
  const actualCombinations = enhancedCropCalls.map((call) => ({ scale: call.options?.scale, threshold: call.options?.threshold }));
  const expectedCombinations = ENHANCED_FALLBACK_ATTEMPTS.map((attempt) => ({ scale: attempt.scale, threshold: attempt.threshold }));

  assert.deepEqual(actualCombinations, expectedCombinations);
  assert.ok(enhancedCropCalls.every((call) => call.top === CANDIDATES[0]!.top));
});

test('local provider uses each configured deskew angle in order, per candidate', async () => {
  const { deps, cropCalls } = buildDeps();
  const provider = createLocalProvider(deps);

  await provider.extract(Buffer.from('fake-image-bytes'), 'image/jpeg');

  const deskewStart = 1 + 2 + ENHANCED_FALLBACK_ATTEMPTS.length + TRIM_FALLBACK_ATTEMPTS.length;
  const deskewCropCalls = cropCalls.slice(deskewStart, deskewStart + DESKEW_FALLBACK_ATTEMPTS.length);
  const actualAngles = deskewCropCalls.map((call) => call.options?.rotateDegrees);
  const expectedAngles = DESKEW_FALLBACK_ATTEMPTS.map((attempt) => attempt.rotateDegrees);

  assert.deepEqual(actualAngles, expectedAngles);
  assert.ok(deskewCropCalls.every((call) => call.options?.binarize === true));
  assert.ok(deskewCropCalls.every((call) => call.top === CANDIDATES[0]!.top));
});

test('the maximum number of Tesseract attempts across the entire local pipeline is bounded and enumerable', async () => {
  const { deps, calls } = buildDeps();
  const provider = createLocalProvider(deps);

  await provider.extract(Buffer.from('fake-image-bytes'), 'image/jpeg');

  assert.equal(CANDIDATES.length, 3);
  assert.equal(OCR_CALLS_PER_CANDIDATE, 17, '1 (binarized) + 2 (split) + 8 (enhanced) + 2 (localized) + 4 (deskew)');
  assert.equal(ALL_BOUNDED_OCR_CALLS, 51, '3 candidates x 17 attempts each');
  assert.equal(calls.ocr, ALL_BOUNDED_OCR_CALLS);
});
