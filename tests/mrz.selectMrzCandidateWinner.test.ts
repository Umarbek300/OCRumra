import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectMrzCandidateWinner } from '../src/ocr/mrz/selectMrzCandidateWinner.js';
import type { MrzCandidateWindow } from '../src/ocr/mrz/findMrzCandidateWindows.js';

// Canonical ICAO 9303 sample MRZ (published reference data, not a real
// document), real ISO country code substituted — see
// tests/mrz.parseAndValidateMrz.test.ts for why.
const VALID_LINE_1 = 'P<USAERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<';
const VALID_LINE_2 = 'L898902C36USA7408122F1204159ZE184226B<<<<<10';
const CORRUPTED_CHECK_DIGIT_LINE_2 = 'L898902C35USA7408122F1204159ZE184226B<<<<<10';
// Independently computed (ICAO check-digit algorithm), structurally
// identical to real message 270/271's Vision-read line 2 (44 chars, valid
// MRZ alphabet, zero '<' filler) — see tests/mrz.parseAndValidateMrz.test.ts.
const VALID_LINE_2_NO_FILLER = 'L898902C36USA7408122F1204159ZE184226B1234508';
// Not even a recognizable MRZ shape at the format-dispatch level.
const UNRECOGNIZABLE_LINES: [string, string] = ['TOO<SHORT', 'ALSO<TOO<SHORT'];

function makeWindow(windowIndex: number, lines: [string, string]): MrzCandidateWindow {
  return {
    lines,
    window: {
      windowIndex,
      rawLengths: [lines[0].length, lines[1].length],
      normalizedLengths: [lines[0].length, lines[1].length],
      looksLikeMrz: [true, true],
    },
  };
}

test('selectMrzCandidateWinner returns both null when there are no windows', () => {
  const selection = selectMrzCandidateWinner([]);
  assert.equal(selection.validWinner, null);
  assert.equal(selection.firstStructuralMatch, null);
});

test('selectMrzCandidateWinner returns both null when no window is even structurally recognizable', () => {
  const windows = [makeWindow(0, UNRECOGNIZABLE_LINES), makeWindow(1, UNRECOGNIZABLE_LINES)];
  const selection = selectMrzCandidateWinner(windows);
  assert.equal(selection.validWinner, null);
  assert.equal(selection.firstStructuralMatch, null);
});

test('selectMrzCandidateWinner sets validWinner=null and firstStructuralMatch to the first structurally-shaped-but-checksum-invalid window, when no window checksum-validates', () => {
  const windows = [makeWindow(0, UNRECOGNIZABLE_LINES), makeWindow(1, [VALID_LINE_1, CORRUPTED_CHECK_DIGIT_LINE_2])];
  const selection = selectMrzCandidateWinner(windows);

  assert.equal(selection.validWinner, null);
  assert.ok(selection.firstStructuralMatch);
  assert.equal(selection.firstStructuralMatch!.windowIndex, 1);
  assert.equal(selection.firstStructuralMatch!.parsed.valid, false);
});

test('selectMrzCandidateWinner sets validWinner to the checksum-valid window, tracking it separately from an earlier checksum-invalid structural match', () => {
  const windows = [
    makeWindow(0, [VALID_LINE_1, CORRUPTED_CHECK_DIGIT_LINE_2]), // structurally shaped, checksum-invalid, comes first
    makeWindow(1, [VALID_LINE_1, VALID_LINE_2]), // genuinely valid, comes second
  ];
  const selection = selectMrzCandidateWinner(windows);

  assert.ok(selection.validWinner);
  assert.equal(selection.validWinner!.windowIndex, 1);
  assert.equal(selection.validWinner!.parsed.valid, true);

  // The earlier invalid candidate is still surfaced separately — never
  // silently discarded, never conflated with the genuine winner.
  assert.ok(selection.firstStructuralMatch);
  assert.equal(selection.firstStructuralMatch!.windowIndex, 0);
  assert.equal(selection.firstStructuralMatch!.parsed.valid, false);
});

test('selectMrzCandidateWinner sets both validWinner and firstStructuralMatch to the same window when the very first window is already checksum-valid', () => {
  const windows = [makeWindow(0, [VALID_LINE_1, VALID_LINE_2]), makeWindow(1, [VALID_LINE_1, CORRUPTED_CHECK_DIGIT_LINE_2])];
  const selection = selectMrzCandidateWinner(windows);

  assert.ok(selection.validWinner);
  assert.equal(selection.validWinner!.windowIndex, 0);
  assert.ok(selection.firstStructuralMatch);
  assert.equal(selection.firstStructuralMatch!.windowIndex, 0);
});

test('selectMrzCandidateWinner stops scanning after the first checksum-valid window and returns that one, not a later valid one', () => {
  const windows = [
    makeWindow(0, [VALID_LINE_1, CORRUPTED_CHECK_DIGIT_LINE_2]),
    makeWindow(1, [VALID_LINE_1, VALID_LINE_2]), // first genuinely valid
    makeWindow(2, [VALID_LINE_1, VALID_LINE_2]), // also valid, but must never be reached/returned
  ];
  const selection = selectMrzCandidateWinner(windows);

  assert.ok(selection.validWinner);
  assert.equal(selection.validWinner!.windowIndex, 1);
});

test('selectMrzCandidateWinner finds a checksum-valid winner even when its line 2 has zero "<" filler characters — the exact real message 270/271 shape', () => {
  const windows = [makeWindow(0, [VALID_LINE_1, VALID_LINE_2_NO_FILLER])];
  const selection = selectMrzCandidateWinner(windows);

  assert.ok(selection.validWinner, 'expected a filler-less but checksum-correct line 2 to still win');
  assert.equal(selection.validWinner!.parsed.valid, true);
});

test('selectMrzCandidateWinner never includes raw line content in its returned structure beyond the lines field itself — windowIndex and parsed are structural/derived only', () => {
  const windows = [makeWindow(0, [VALID_LINE_1, VALID_LINE_2])];
  const selection = selectMrzCandidateWinner(windows);

  assert.ok(selection.validWinner);
  const keys = Object.keys(selection.validWinner!).sort();
  assert.deepEqual(keys, ['lines', 'parsed', 'windowIndex']);
});
