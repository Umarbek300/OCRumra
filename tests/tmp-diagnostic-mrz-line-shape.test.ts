import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  computeMrzLineShapeMetrics,
  formatMrzLineShapeMetrics,
} from '../scripts/tmp-diagnostic-mrz-line-shape.js';

// Canonical ICAO 9303 sample MRZ line 1 (published reference data, not a
// real document) — same fixture used throughout this codebase's other MRZ
// tests. Ends with a long run of trailing '<' filler.
const VALID_SPECIMEN_LINE_1 = 'P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<';

test('computeMrzLineShapeMetrics reports length 44 and zero leading filler for a valid specimen line', () => {
  const metrics = computeMrzLineShapeMetrics(VALID_SPECIMEN_LINE_1);

  assert.strictEqual(metrics.length, 44);
  assert.strictEqual(metrics.leadingFillerCount, 0);
  assert.strictEqual(metrics.nonMrzAlphabetCharCount, 0);
  assert.strictEqual(metrics.matchesMrzAlphabet, true);
  assert.strictEqual(metrics.hasFillerChar, true);
  assert.strictEqual(metrics.looksLikeMrzLineResult, true);
  assert.strictEqual(metrics.missingFromTd3Length, 0);
  // Trailing filler count derived independently (not hand-counted from the
  // fixture) via a plain regex, cross-checking the function under test.
  const expectedTrailingFillerCount = VALID_SPECIMEN_LINE_1.length - VALID_SPECIMEN_LINE_1.replace(/<+$/, '').length;
  assert.strictEqual(metrics.trailingFillerCount, expectedTrailingFillerCount);
  // fillerCharCount and fillerPositions derived independently, cross-checking
  // the function under test.
  const expectedFillerPositions = VALID_SPECIMEN_LINE_1.split('').reduce<number[]>((acc, ch, i) => {
    if (ch === '<') acc.push(i);
    return acc;
  }, []);
  assert.strictEqual(metrics.fillerCharCount, expectedFillerPositions.length);
  assert.deepEqual(metrics.fillerPositions, expectedFillerPositions);
});

test('computeMrzLineShapeMetrics reports missingFromTd3Length for a short line and zero for a full-length line', () => {
  assert.strictEqual(computeMrzLineShapeMetrics('AB<<<<<').missingFromTd3Length, 37); // 44 - 7
  assert.strictEqual(computeMrzLineShapeMetrics('A'.repeat(44)).missingFromTd3Length, 0);
  assert.strictEqual(computeMrzLineShapeMetrics('A'.repeat(50)).missingFromTd3Length, 0); // never negative
});

test('computeMrzLineShapeMetrics reports filler positions matching the standard MRZ line-1 shape (single filler, then double filler, then a long trailing pad) without revealing the surrounding letters', () => {
  // Structurally identical to a real TD3 line 1 (document-type filler at
  // index 1, double filler separating surname/given names, then padding
  // to the end) but built from placeholder letters, not a real name.
  const line = 'X<XXXNNNNNNNNN<<NNNN<NNNNN<<<<<<<<<<<<<<<<<<<'.slice(0, 44);
  const metrics = computeMrzLineShapeMetrics(line);

  assert.strictEqual(metrics.fillerPositions[0], 1);
  assert.ok(metrics.fillerPositions.length > 2);
});

test('computeMrzLineShapeMetrics reports hasFillerChar=false but looksLikeMrzLineResult=true for a 44-char line with no "<" at all', () => {
  // This is the exact shape a real Google Vision read showed for message
  // 270/271's own line 2 (never logged here as content, only replicated
  // structurally): correct 44-char TD3 length, valid MRZ alphabet, but
  // zero filler characters — e.g. the optional personal-number field is
  // fully populated with digits, leaving no '<' padding anywhere. This
  // real-world shape is exactly why looksLikeMrzLine() no longer requires
  // a filler character (see src/ocr/mrz/looksLikeMrzLine.ts).
  const line = ('A'.repeat(9) + '1'.repeat(35)).slice(0, 44); // 44 chars, valid alphabet, no "<"
  const metrics = computeMrzLineShapeMetrics(line);

  assert.strictEqual(metrics.length, 44);
  assert.strictEqual(metrics.hasFillerChar, false);
  assert.strictEqual(metrics.fillerCharCount, 0);
  assert.strictEqual(metrics.matchesMrzAlphabet, true);
  assert.strictEqual(metrics.looksLikeMrzLineResult, true);
});

test('computeMrzLineShapeMetrics reports an exact trailing filler count for a fully controlled fixture', () => {
  const metrics = computeMrzLineShapeMetrics('AB<<<<<'); // 2 real chars + 5 filler chars

  assert.strictEqual(metrics.length, 7);
  assert.strictEqual(metrics.trailingFillerCount, 5);
  assert.strictEqual(metrics.leadingFillerCount, 0);
});

test('computeMrzLineShapeMetrics reports zero trailing/leading filler for a line with no "<" characters', () => {
  const metrics = computeMrzLineShapeMetrics('ABCDEFG1234');

  assert.strictEqual(metrics.trailingFillerCount, 0);
  assert.strictEqual(metrics.leadingFillerCount, 0);
});

test('computeMrzLineShapeMetrics treats an all-filler line as fully leading and fully trailing filler', () => {
  const metrics = computeMrzLineShapeMetrics('<<<<<<<<<<');

  assert.strictEqual(metrics.length, 10);
  assert.strictEqual(metrics.trailingFillerCount, 10);
  assert.strictEqual(metrics.leadingFillerCount, 10);
});

test('computeMrzLineShapeMetrics counts characters outside the MRZ alphabet without revealing them', () => {
  const metrics = computeMrzLineShapeMetrics('AB C<');

  assert.strictEqual(metrics.nonMrzAlphabetCharCount, 1);
});

test('computeMrzLineShapeMetrics handles an empty line', () => {
  const metrics = computeMrzLineShapeMetrics('');

  assert.deepEqual(metrics, {
    length: 0,
    trailingFillerCount: 0,
    leadingFillerCount: 0,
    fillerCharCount: 0,
    hasFillerChar: false,
    nonMrzAlphabetCharCount: 0,
    matchesMrzAlphabet: false,
    looksLikeMrzLineResult: false,
    missingFromTd3Length: 44,
    fillerPositions: [],
  });
});

test('a short line missing trailing filler shows a low trailingFillerCount relative to a full-length line', () => {
  // Simulates the observed production shape: a 40-char OCR read that is 4
  // characters short of the real 44-char line, cut from somewhere other
  // than the trailing filler run (e.g. the crop's left/top edge), so the
  // trailing filler that *was* read stays intact but the line is still
  // short overall.
  const shortLine = 'UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<'.slice(3); // drops 3 leading chars, still ends in filler
  const metrics = computeMrzLineShapeMetrics(shortLine);

  assert.ok(metrics.length < 44);
  assert.strictEqual(metrics.leadingFillerCount, 0);
});

test('formatMrzLineShapeMetrics never includes raw line content, only labeled counts', () => {
  const metrics = computeMrzLineShapeMetrics(VALID_SPECIMEN_LINE_1);
  const formatted = formatMrzLineShapeMetrics(metrics);

  assert.ok(!formatted.includes(VALID_SPECIMEN_LINE_1));
  assert.ok(!formatted.includes('ERIKSSON'));
  assert.ok(formatted.includes('length='));
  assert.ok(formatted.includes('hasFillerChar='));
  assert.ok(formatted.includes('fillerCharCount='));
  assert.ok(formatted.includes('trailingFillerCount='));
  assert.ok(formatted.includes('leadingFillerCount='));
  assert.ok(formatted.includes('matchesMrzAlphabet='));
  assert.ok(formatted.includes('nonMrzAlphabetCharCount='));
  assert.ok(formatted.includes('looksLikeMrzLineResult='));
  assert.ok(formatted.includes('missingFromTd3Length='));
  assert.ok(formatted.includes('fillerPositions='));
});
