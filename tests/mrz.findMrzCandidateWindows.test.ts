import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findMrzCandidateWindows } from '../src/ocr/mrz/findMrzCandidateWindows.js';

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
  // OCR miss (dropped trailing filler char). Must still surface as a
  // candidate for downstream checksum validation, not be discarded purely
  // on length.
  const shortLine1 = VALID_SPECIMEN_LINE_1.slice(0, -1); // 43 chars
  const fullText = ['some header text', shortLine1, VALID_SPECIMEN_LINE_2, 'some footer text'].join('\n');

  const windows = findMrzCandidateWindows(fullText);

  const match = windows.find((w) => w.window.rawLengths[0] === 43);
  assert.ok(match, 'expected a 43-character line to still be surfaced as a candidate window');
});

test('findMrzCandidateWindows finds a candidate pair even when the second line has no "<" filler character at all — the exact shape a real Google Vision read produced for real messages 270/271, where the optional personal-number field is fully used', () => {
  // 44 chars, valid MRZ alphabet, but zero '<' anywhere — structurally
  // replicated here, never real document content.
  const line2NoFiller = ('A'.repeat(9) + '1'.repeat(35)).slice(0, 44);
  const fullText = [VALID_SPECIMEN_LINE_1, line2NoFiller].join('\n');

  const windows = findMrzCandidateWindows(fullText);

  const match = windows.find((w) => w.lines[1] === line2NoFiller);
  assert.ok(match, 'expected a filler-less second line to still be surfaced as a candidate window');
  assert.equal(match!.window.looksLikeMrz[1], true, 'looksLikeMrz must be true for a 44-char, alphabet-valid line even with no filler');
});

test('findMrzCandidateWindows returns no candidates when the text has no MRZ-shaped lines at all', () => {
  const fullText = ['REPUBLIC OF UTOPIA', 'PASSPORT', 'Surname: ERIKSSON', 'Given names: ANNA MARIA'].join('\n');

  const windows = findMrzCandidateWindows(fullText);

  assert.deepEqual(windows, []);
});

test('findMrzCandidateWindows returns no candidates for empty input', () => {
  assert.deepEqual(findMrzCandidateWindows(''), []);
});

test('findMrzCandidateWindows records raw length, normalized length, and looksLikeMrz for each candidate', () => {
  const fullText = [VALID_SPECIMEN_LINE_1, VALID_SPECIMEN_LINE_2].join('\n');

  const windows = findMrzCandidateWindows(fullText);
  const match = windows.find((w) => w.lines[0] === VALID_SPECIMEN_LINE_1);

  assert.ok(match);
  assert.deepEqual(match!.window.rawLengths, [44, 44]);
  assert.deepEqual(match!.window.normalizedLengths, [44, 44]);
  assert.deepEqual(match!.window.looksLikeMrz, [true, true]);
});

test('findMrzCandidateWindows never includes raw window content in its window metadata field names — only structural counts and booleans', () => {
  const fullText = [VALID_SPECIMEN_LINE_1, VALID_SPECIMEN_LINE_2].join('\n');
  const windows = findMrzCandidateWindows(fullText);
  const match = windows.find((w) => w.lines[0] === VALID_SPECIMEN_LINE_1);

  assert.ok(match);
  const metaKeys = Object.keys(match!.window);
  assert.deepEqual(metaKeys.sort(), ['looksLikeMrz', 'normalizedLengths', 'rawLengths', 'windowIndex'].sort());
});
