import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { extractMrzLines } from '../src/ocr/mrz/extractMrzLines.js';
import { locateMrzRegion } from '../src/ocr/mrz/locateMrzRegion.js';
import { parseAndValidateMrz } from '../src/ocr/mrz/parseAndValidateMrz.js';
import { runTesseractOcr } from '../src/ocr/mrz/runTesseractOcr.js';
import { searchMrzLines } from '../src/ocr/mrz/searchMrzLines.js';
import { createLocalProvider } from '../src/ocr/providers/localProvider.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'synthetic-mrz-document.png');

function tesseractIsAvailable(): boolean {
  try {
    execFileSync('tesseract', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Real end-to-end coverage of the actual OCR subprocess (crop -> tesseract
// -> parse/validate) against a synthetic fixture — not mocked. Requires the
// `tesseract` binary (this is what production needs installed for
// OCR_PROVIDER=local); skips gracefully rather than failing where it isn't
// present, matching how DB-dependent tests behave in this suite.
test(
  'locateMrzRegion + runTesseractOcr + parseAndValidateMrz recover a valid, checksum-verified MRZ from a synthetic document image',
  { skip: !tesseractIsAvailable() ? 'tesseract binary not found on PATH' : false },
  async () => {
    const imageBuffer = await readFile(FIXTURE_PATH);

    const mrzRegion = await locateMrzRegion(imageBuffer);
    const rawOcrText = await runTesseractOcr(mrzRegion);
    const mrzLines = extractMrzLines(rawOcrText);

    assert.equal(mrzLines.length, 2);

    const parsed = parseAndValidateMrz(mrzLines);
    assert.ok(parsed, 'OCR output must be a recognizable TD3 MRZ shape');
    assert.equal(parsed.format, 'TD3');
    assert.equal(parsed.fields.documentNumber, 'L898902C3');
    assert.equal(parsed.fields.lastName, 'ERIKSSON');

    const documentNumberCheck = parsed.details.find((detail) => detail.field === 'documentNumberCheckDigit');
    assert.equal(documentNumberCheck?.valid, true, 'real OCR output must pass real check-digit validation');
  },
);

// Same real-binary coverage, but for the new primary candidate-search
// strategy (searchMrzLines) rather than the old single fixed crop.
test(
  'searchMrzLines recovers a valid, checksum-verified MRZ from a synthetic document image using real Tesseract',
  { skip: !tesseractIsAvailable() ? 'tesseract binary not found on PATH' : false },
  async () => {
    const imageBuffer = await readFile(FIXTURE_PATH);

    const result = await searchMrzLines(imageBuffer);

    assert.ok(result, 'the candidate search must find a valid MRZ in this well-framed fixture');
    assert.equal(result.parsed.fields.documentNumber, 'L898902C3');
    const documentNumberCheck = result.parsed.details.find((detail) => detail.field === 'documentNumberCheckDigit');
    assert.equal(documentNumberCheck?.valid, true);
  },
);

// Full end-to-end through the actual provider (staged pipeline), real
// Tesseract, real fixture — the same code path production runs.
test(
  'the local provider recovers a valid MRZ end to end using real Tesseract',
  { skip: !tesseractIsAvailable() ? 'tesseract binary not found on PATH' : false },
  async () => {
    const imageBuffer = await readFile(FIXTURE_PATH);
    const provider = createLocalProvider();

    const result = await provider.extract(imageBuffer, 'image/png');

    assert.equal(result.surname.value, 'ERIKSSON');
    assert.equal(result.passportNumber.value, 'L898902C3');
    assert.notEqual(result.overallConfidence, 'low');
  },
);
