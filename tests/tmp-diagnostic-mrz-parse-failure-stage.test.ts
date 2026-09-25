import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  diagnoseMrzParseFailure,
  formatMrzParseDiagnosticResult,
} from '../scripts/tmp-diagnostic-mrz-parse-failure-stage.js';

// Canonical ICAO 9303 sample MRZ (published reference data, not a real
// document), with the spec's fictitious "UTO" (Utopia) issuing/nationality
// code swapped for a real ISO code ("USA"): the `mrz` package validates
// country codes against a real-country list, so the original UTO specimen
// — used elsewhere in this codebase only for checksum-field-level checks,
// never an overall `.valid` assertion — correctly comes back
// `valid: false` purely on that unrelated field, which would make a
// "success" fixture here misleading. Swapping the code changes nothing
// checksum-related (country code isn't part of any check-digit
// calculation).
const VALID_SPECIMEN_LINE_1 = 'P<USAERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<';
const VALID_SPECIMEN_LINE_2 = 'L898902C36USA7408122F1204159ZE184226B<<<<<10';

test('diagnoseMrzParseFailure reports success for a valid 44/44 specimen pair', () => {
  const result = diagnoseMrzParseFailure([VALID_SPECIMEN_LINE_1, VALID_SPECIMEN_LINE_2]);

  assert.deepEqual(result.lineLengths, [44, 44]);
  assert.strictEqual(result.parseAndValidateMrzSuccess, true);
  assert.strictEqual(result.failureCategory, 'success');
});

test('diagnoseMrzParseFailure categorizes a 40/44 pair (line0 not a recognized TD-format length) as format-dispatch failure — the exact shape observed for real message 270 candidate 0/1', () => {
  const shortLine1 = VALID_SPECIMEN_LINE_1.slice(0, 40);
  const result = diagnoseMrzParseFailure([shortLine1, VALID_SPECIMEN_LINE_2]);

  assert.deepEqual(result.lineLengths, [40, 44]);
  assert.strictEqual(result.parseAndValidateMrzSuccess, false);
  assert.strictEqual(result.failureCategory, 'format-dispatch-unrecognized-line0-length');
});

test('diagnoseMrzParseFailure categorizes a 42/43 pair as format-dispatch failure — the exact shape observed for real message 270 candidate 2', () => {
  const line1 = VALID_SPECIMEN_LINE_1.slice(0, 42);
  const line2 = VALID_SPECIMEN_LINE_2.slice(0, 43);
  const result = diagnoseMrzParseFailure([line1, line2]);

  assert.deepEqual(result.lineLengths, [42, 43]);
  assert.strictEqual(result.parseAndValidateMrzSuccess, false);
  assert.strictEqual(result.failureCategory, 'format-dispatch-unrecognized-line0-length');
});

test('diagnoseMrzParseFailure categorizes a 44/40 pair (line0 recognized as TD3, but line1 wrong length) as a td3 line-length failure', () => {
  const shortLine2 = VALID_SPECIMEN_LINE_2.slice(0, 40);
  const result = diagnoseMrzParseFailure([VALID_SPECIMEN_LINE_1, shortLine2]);

  assert.deepEqual(result.lineLengths, [44, 40]);
  assert.strictEqual(result.parseAndValidateMrzSuccess, false);
  assert.strictEqual(result.failureCategory, 'td3-line-length-mismatch');
});

test('diagnoseMrzParseFailure categorizes a structurally correct 44/44 pair with a corrupted check digit as checksum-or-field-level-invalid, and notes parseAndValidateMrz still returns non-null for it', () => {
  // Document-number check digit deliberately wrong (6 -> 5). The `mrz`
  // package never throws for this — it returns a result object with
  // valid: false on the affected field(s) instead — so
  // parseAndValidateMrz() (which only returns null on a caught exception)
  // still returns a non-null result here. This is an intentional,
  // pre-existing behavior of the production wrapper being documented by
  // this diagnostic, not something this script changes.
  const corruptedLine2 = 'L898902C35USA7408122F1204159ZE184226B<<<<<10';
  const result = diagnoseMrzParseFailure([VALID_SPECIMEN_LINE_1, corruptedLine2]);

  assert.deepEqual(result.lineLengths, [44, 44]);
  assert.strictEqual(result.failureCategory, 'checksum-or-field-level-invalid');
  assert.strictEqual(result.parseAndValidateMrzSuccess, true);
});

test('diagnoseMrzParseFailure categorizes a single-line input as a line-count failure', () => {
  const result = diagnoseMrzParseFailure([VALID_SPECIMEN_LINE_1]);

  assert.strictEqual(result.parseAndValidateMrzSuccess, false);
  assert.notStrictEqual(result.failureCategory, 'success');
});

test('formatMrzParseDiagnosticResult never includes raw line content, only labeled counts and a category name', () => {
  const result = diagnoseMrzParseFailure([VALID_SPECIMEN_LINE_1, VALID_SPECIMEN_LINE_2]);
  const formatted = formatMrzParseDiagnosticResult(result);

  assert.ok(!formatted.includes(VALID_SPECIMEN_LINE_1));
  assert.ok(!formatted.includes(VALID_SPECIMEN_LINE_2));
  assert.ok(!formatted.includes('ERIKSSON'));
  assert.ok(formatted.includes('lineLengths='));
  assert.ok(formatted.includes('parseAndValidateMrzSuccess='));
  assert.ok(formatted.includes('failureCategory='));
});
