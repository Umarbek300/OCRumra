import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import type { SearchMrzLinesDependencies } from '../src/ocr/mrz/searchMrzLines.js';
import { formatSearchMrzLinesResult, runSearchMrzLinesDiagnostic } from '../scripts/tmp-diagnostic-search-mrz-lines.js';

// Canonical ICAO 9303 sample MRZ (published reference data, not a real
// document) — same fixture production's own mrz.searchMrzLines.test.ts uses.
const VALID_SPECIMEN_LINES = ['P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<', 'L898902C36UTO7408122F1204159ZE184226B<<<<<10'];

function brokenChecksumLine2(): string {
  return VALID_SPECIMEN_LINES[1]!.slice(0, -1) + '1';
}

async function makeTestImage(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .png()
    .toBuffer();
}

function buildDeps(runTesseractOcr: SearchMrzLinesDependencies['runTesseractOcr']): SearchMrzLinesDependencies {
  return {
    cropRegion: async (buffer) => buffer,
    runTesseractOcr,
  };
}

test('runSearchMrzLinesDiagnostic reports parseSuccess=true and checksumValid=true for a genuine, correct MRZ pair', async () => {
  const image = await makeTestImage(900, 1200);
  const deps = buildDeps(async () => VALID_SPECIMEN_LINES.join('\n'));

  const result = await runSearchMrzLinesDiagnostic(image, deps);

  assert.strictEqual(result.imageWidth, 900);
  assert.strictEqual(result.imageHeight, 1200);
  assert.strictEqual(result.parseSuccess, true);
  assert.strictEqual(result.lineCount, 2);
  assert.deepStrictEqual(result.lineLengths, [44, 44]);
  assert.strictEqual(result.checksumValid, true);
});

test('runSearchMrzLinesDiagnostic reports parseSuccess=true but checksumValid=false for a structurally valid pair with a broken check digit', async () => {
  const image = await makeTestImage(900, 1200);
  const deps = buildDeps(async () => `${VALID_SPECIMEN_LINES[0]}\n${brokenChecksumLine2()}`);

  const result = await runSearchMrzLinesDiagnostic(image, deps);

  assert.strictEqual(result.parseSuccess, true);
  assert.strictEqual(result.checksumValid, false);
});

test('runSearchMrzLinesDiagnostic reports parseSuccess=false, lineCount=0, checksumValid=null when no candidate matches', async () => {
  const image = await makeTestImage(900, 1200);
  const deps = buildDeps(async () => 'garbage');

  const result = await runSearchMrzLinesDiagnostic(image, deps);

  assert.strictEqual(result.parseSuccess, false);
  assert.strictEqual(result.lineCount, 0);
  assert.deepStrictEqual(result.lineLengths, []);
  assert.strictEqual(result.checksumValid, null);
});

test('runSearchMrzLinesDiagnostic reports the same candidate geometry production findMrzCandidateRegions produces', async () => {
  const image = await makeTestImage(900, 1000);
  const deps = buildDeps(async () => 'garbage');

  const result = await runSearchMrzLinesDiagnostic(image, deps);

  assert.strictEqual(result.candidateCount, 3);
  assert.deepStrictEqual(result.candidates, [
    { top: 750, height: 250 },
    { top: 680, height: 320 },
    { top: 600, height: 400 },
  ]);
});

test('runSearchMrzLinesDiagnostic reports a non-negative processing time', async () => {
  const image = await makeTestImage(900, 1200);
  const deps = buildDeps(async () => VALID_SPECIMEN_LINES.join('\n'));

  const result = await runSearchMrzLinesDiagnostic(image, deps);

  assert.ok(result.processingTimeMs >= 0);
});

test('formatSearchMrzLinesResult renders only numeric/boolean fields, never raw MRZ line content', async () => {
  const image = await makeTestImage(900, 1200);
  const deps = buildDeps(async () => VALID_SPECIMEN_LINES.join('\n'));
  const result = await runSearchMrzLinesDiagnostic(image, deps);

  const formatted = formatSearchMrzLinesResult(result);

  assert.ok(!formatted.includes(VALID_SPECIMEN_LINES[0]!));
  assert.ok(!formatted.includes(VALID_SPECIMEN_LINES[1]!));
  assert.ok(formatted.includes('candidateCount'));
  assert.ok(formatted.includes('parseSuccess'));
  assert.ok(formatted.includes('checksumValid'));
  assert.ok(formatted.includes('lineLengths'));
});
