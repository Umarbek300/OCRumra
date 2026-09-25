import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildVariantDiagnosticResult,
  formatVariantDiagnosticResult,
  LINE0_RECOVERY_VARIANTS,
} from '../scripts/tmp-diagnostic-mrz-line0-recovery-sweep.js';

// Canonical ICAO 9303 sample MRZ, real ISO country code substituted (see
// tmp-diagnostic-mrz-parse-failure-stage.test.ts for why: the spec's
// fictitious "UTO" fails the `mrz` package's real-country-list check
// unrelated to any checksum).
const VALID_SPECIMEN_LINE_1 = 'P<USAERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<';
const VALID_SPECIMEN_LINE_2 = 'L898902C36USA7408122F1204159ZE184226B<<<<<10';

test('LINE0_RECOVERY_VARIANTS is a bounded, fixed list with unique names', () => {
  assert.ok(LINE0_RECOVERY_VARIANTS.length > 0);
  const names = LINE0_RECOVERY_VARIANTS.map((v) => v.name);
  assert.strictEqual(new Set(names).size, names.length);
});

test('buildVariantDiagnosticResult reports line0Reached44=true and parseSuccess=true for a full-length, valid pair', () => {
  const result = buildVariantDiagnosticResult(0, 'baseline-psm6', [VALID_SPECIMEN_LINE_1, VALID_SPECIMEN_LINE_2]);

  assert.strictEqual(result.line0Length, 44);
  assert.strictEqual(result.line0Reached44, true);
  assert.strictEqual(result.line0MissingFromTd3Length, 0);
  assert.strictEqual(result.line0MatchesMrzAlphabet, true);
  assert.strictEqual(result.parseSuccess, true);
  assert.strictEqual(result.parseFailureCategory, 'success');
});

test('buildVariantDiagnosticResult reports line0Reached44=false and the format-dispatch category for a 40-char line0 — the exact shape observed for real message 270 candidate 0/1', () => {
  const shortLine0 = VALID_SPECIMEN_LINE_1.slice(0, 40);
  const result = buildVariantDiagnosticResult(0, 'baseline-psm6', [shortLine0, VALID_SPECIMEN_LINE_2]);

  assert.strictEqual(result.line0Length, 40);
  assert.strictEqual(result.line0Reached44, false);
  assert.strictEqual(result.line0MissingFromTd3Length, 4);
  assert.strictEqual(result.parseSuccess, false);
  assert.strictEqual(result.parseFailureCategory, 'format-dispatch-unrecognized-line0-length');
});

test('buildVariantDiagnosticResult handles a missing second line without throwing', () => {
  const result = buildVariantDiagnosticResult(2, 'enhanced-scale3-plain', [VALID_SPECIMEN_LINE_1]);

  assert.strictEqual(result.line1Length, 0);
});

test('formatVariantDiagnosticResult never includes raw line content, only labeled structural metrics', () => {
  const result = buildVariantDiagnosticResult(1, 'baseline-psm7', [VALID_SPECIMEN_LINE_1, VALID_SPECIMEN_LINE_2]);
  const formatted = formatVariantDiagnosticResult(result);

  assert.ok(!formatted.includes(VALID_SPECIMEN_LINE_1));
  assert.ok(!formatted.includes(VALID_SPECIMEN_LINE_2));
  assert.ok(!formatted.includes('ERIKSSON'));
  assert.ok(formatted.includes('candidate='));
  assert.ok(formatted.includes('variant='));
  assert.ok(formatted.includes('line0Length='));
  assert.ok(formatted.includes('line1Length='));
  assert.ok(formatted.includes('line0TrailingFillerCount='));
  assert.ok(formatted.includes('line0MissingFromTd3Length='));
  assert.ok(formatted.includes('line0MatchesMrzAlphabet='));
  assert.ok(formatted.includes('line0Reached44='));
  assert.ok(formatted.includes('parseSuccess='));
  assert.ok(formatted.includes('parseFailureCategory='));
});
