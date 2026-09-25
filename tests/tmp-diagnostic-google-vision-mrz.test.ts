import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  findMrzCandidateWindows,
  runGoogleVisionMrzDiagnostic,
  formatGoogleVisionMrzDiagnosticResult,
  type DetectDocumentTextFn,
} from '../scripts/tmp-diagnostic-google-vision-mrz.js';

// Canonical ICAO 9303 sample MRZ (published reference data, not a real
// document) — same fixture used throughout this codebase's other MRZ tests.
const VALID_SPECIMEN_LINE_1 = 'P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<';
const VALID_SPECIMEN_LINE_2 = 'L898902C36UTO7408122F1204159ZE184226B<<<<<10';

test('findMrzCandidateWindows finds a valid MRZ pair embedded in a larger multi-line document', () => {
  const fullText = [
    'REPUBLIC OF UTOPIA',
    'PASSPORT',
    'Surname: ERIKSSON',
    'Given names: ANNA MARIA',
    VALID_SPECIMEN_LINE_1,
    VALID_SPECIMEN_LINE_2,
    'Issuing authority: UTOPIA',
  ].join('\n');

  const windows = findMrzCandidateWindows(fullText);

  assert.ok(windows.length >= 1, 'expected at least one candidate window');
  const match = windows.find((w) => w.lines[0] === VALID_SPECIMEN_LINE_1 && w.lines[1] === VALID_SPECIMEN_LINE_2);
  assert.ok(match, 'expected the real MRZ pair to be found as a candidate window');
});

test('findMrzCandidateWindows does not require an exact 44-character length to consider a window a candidate', () => {
  // One character short of the real TD3 length (43, not 44) — a realistic
  // Vision OCR miss (dropped trailing filler char). Must still surface as
  // a candidate for diagnostic purposes, not be discarded before ever
  // reaching parseAndValidateMrz.
  const shortLine1 = VALID_SPECIMEN_LINE_1.slice(0, -1); // 43 chars
  const fullText = ['some header text', shortLine1, VALID_SPECIMEN_LINE_2, 'some footer text'].join('\n');

  const windows = findMrzCandidateWindows(fullText);

  const match = windows.find((w) => w.window.rawLengths[0] === 43);
  assert.ok(match, 'expected a 43-character line to still be surfaced as a candidate window');
});

test('findMrzCandidateWindows returns no candidates when the text has no MRZ-shaped lines at all', () => {
  const fullText = ['REPUBLIC OF UTOPIA', 'PASSPORT', 'Surname: ERIKSSON', 'Given names: ANNA MARIA'].join('\n');

  const windows = findMrzCandidateWindows(fullText);

  assert.deepEqual(windows, []);
});

test('findMrzCandidateWindows returns no candidates for empty input', () => {
  assert.deepEqual(findMrzCandidateWindows(''), []);
});

test('findMrzCandidateWindows records raw length, normalized length, and looksLikeMrzLine for each candidate', () => {
  const fullText = [VALID_SPECIMEN_LINE_1, VALID_SPECIMEN_LINE_2].join('\n');

  const windows = findMrzCandidateWindows(fullText);
  const match = windows.find((w) => w.lines[0] === VALID_SPECIMEN_LINE_1);

  assert.ok(match);
  assert.deepEqual(match!.window.rawLengths, [44, 44]);
  assert.deepEqual(match!.window.normalizedLengths, [44, 44]);
  assert.deepEqual(match!.window.looksLikeMrz, [true, true]);
});

test('runGoogleVisionMrzDiagnostic reports success and a winning window for a valid embedded MRZ', async () => {
  const fullText = ['REPUBLIC OF UTOPIA', VALID_SPECIMEN_LINE_1, VALID_SPECIMEN_LINE_2, 'footer'].join('\n');
  const detectDocumentText: DetectDocumentTextFn = async () => fullText;

  const result = await runGoogleVisionMrzDiagnostic(Buffer.from('fake-image'), detectDocumentText);

  assert.strictEqual(result.visionSuccess, true);
  assert.strictEqual(result.visionErrorReason, null);
  assert.ok(result.candidateCount >= 1);
  assert.notStrictEqual(result.winnerWindowIndex, null);
  const winner = result.candidates.find((c) => c.windowIndex === result.winnerWindowIndex);
  assert.ok(winner);
  assert.strictEqual(winner!.parseSuccess, true);
});

test('runGoogleVisionMrzDiagnostic reports success with zero candidates when Vision finds text but no MRZ shape', async () => {
  const detectDocumentText: DetectDocumentTextFn = async () => 'REPUBLIC OF UTOPIA\nPASSPORT\nSurname: ERIKSSON';

  const result = await runGoogleVisionMrzDiagnostic(Buffer.from('fake-image'), detectDocumentText);

  assert.strictEqual(result.visionSuccess, true);
  assert.strictEqual(result.candidateCount, 0);
  assert.strictEqual(result.winnerWindowIndex, null);
});

test('runGoogleVisionMrzDiagnostic reports controlled failure (never throws) when the Vision API call itself fails', async () => {
  const detectDocumentText: DetectDocumentTextFn = async () => {
    throw new Error('7 PERMISSION_DENIED: Cloud Vision API has not been used in project ocrumra before or it is disabled');
  };

  const result = await runGoogleVisionMrzDiagnostic(Buffer.from('fake-image'), detectDocumentText);

  assert.strictEqual(result.visionSuccess, false);
  assert.match(result.visionErrorReason ?? '', /PERMISSION_DENIED/);
  assert.strictEqual(result.candidateCount, 0);
  assert.strictEqual(result.winnerWindowIndex, null);
});

test('runGoogleVisionMrzDiagnostic reports controlled failure when credentials are missing (never throws, no filesystem manipulation needed)', async () => {
  const detectDocumentText: DetectDocumentTextFn = async () => {
    // Shape of the real google-auth-library error when
    // GOOGLE_APPLICATION_CREDENTIALS is unset or unreadable.
    throw new Error(
      'Could not load the default credentials. Browse to https://cloud.google.com/docs/authentication/getting-started for more information.',
    );
  };

  const result = await runGoogleVisionMrzDiagnostic(Buffer.from('fake-image'), detectDocumentText);

  assert.strictEqual(result.visionSuccess, false);
  assert.match(result.visionErrorReason ?? '', /credentials/i);
});

test('runGoogleVisionMrzDiagnostic reports a non-negative latency', async () => {
  const detectDocumentText: DetectDocumentTextFn = async () => VALID_SPECIMEN_LINE_1;
  const result = await runGoogleVisionMrzDiagnostic(Buffer.from('fake-image'), detectDocumentText);
  assert.ok(result.latencyMs >= 0);
});

test('formatGoogleVisionMrzDiagnosticResult never includes the raw OCR text or MRZ line content, only structural facts', async () => {
  const fullText = ['REPUBLIC OF UTOPIA', VALID_SPECIMEN_LINE_1, VALID_SPECIMEN_LINE_2, 'footer'].join('\n');
  const detectDocumentText: DetectDocumentTextFn = async () => fullText;
  const result = await runGoogleVisionMrzDiagnostic(Buffer.from('fake-image'), detectDocumentText);

  const formatted = formatGoogleVisionMrzDiagnosticResult(result);

  assert.ok(!formatted.includes(VALID_SPECIMEN_LINE_1));
  assert.ok(!formatted.includes(VALID_SPECIMEN_LINE_2));
  assert.ok(!formatted.includes('ERIKSSON'));
  assert.ok(!formatted.includes('UTOPIA'));
  assert.ok(formatted.includes('visionSuccess'));
  assert.ok(formatted.includes('candidateCount'));
  assert.ok(formatted.includes('parseSuccess'));
});
