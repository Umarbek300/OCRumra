import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildUnreadableMrzResult, mapMrzToExtractionResult } from '../src/ocr/mrz/mapMrzToExtractionResult.js';
import { parseAndValidateMrz } from '../src/ocr/mrz/parseAndValidateMrz.js';

const VALID_SPECIMEN_LINES = ['P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<', 'L898902C36UTO7408122F1204159ZE184226B<<<<<10'];

function parseValid() {
  const result = parseAndValidateMrz(VALID_SPECIMEN_LINES);
  assert.ok(result, 'specimen MRZ must parse for these tests to be meaningful');
  return result;
}

test('mapMrzToExtractionResult extracts the fields MRZ can provide, splitting given names', () => {
  const extraction = mapMrzToExtractionResult(parseValid(), VALID_SPECIMEN_LINES);

  assert.equal(extraction.surname.value, 'ERIKSSON');
  assert.equal(extraction.firstName.value, 'ANNA');
  assert.equal(extraction.middleName.value, 'MARIA');
  assert.equal(extraction.passportNumber.value, 'L898902C3');
  assert.equal(extraction.dateOfBirth.value, '1974-08-12');
  assert.equal(extraction.passportExpiryDate.value, '2012-04-15');
  assert.equal(extraction.gender.value, 'female');
  assert.equal(extraction.mrz.value, VALID_SPECIMEN_LINES.join('\n'));
  assert.equal(extraction.model, 'tesseract-mrz-local');
});

test('mapMrzToExtractionResult never populates fields MRZ cannot encode', () => {
  const extraction = mapMrzToExtractionResult(parseValid(), VALID_SPECIMEN_LINES);

  assert.deepEqual(extraction.passportIssueDate, { value: null, confidence: null });
  assert.deepEqual(extraction.placeOfBirth, { value: null, confidence: null });
});

test('mapMrzToExtractionResult assigns high confidence to checksum-valid critical fields', () => {
  const extraction = mapMrzToExtractionResult(parseValid(), VALID_SPECIMEN_LINES);

  assert.equal(extraction.passportNumber.confidence, 'high');
  assert.equal(extraction.dateOfBirth.confidence, 'high');
  assert.equal(extraction.passportExpiryDate.confidence, 'high');
});

test('mapMrzToExtractionResult lowers confidence (but keeps the value) when a check digit fails, never invents', () => {
  const corruptedLines = ['P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<', 'L898902C35UTO7408122F1204159ZE184226B<<<<<10'];
  const parsed = parseAndValidateMrz(corruptedLines);
  assert.ok(parsed);
  const extraction = mapMrzToExtractionResult(parsed, corruptedLines);

  assert.equal(extraction.passportNumber.value, 'L898902C3', 'value is still surfaced, not nulled out');
  assert.equal(extraction.passportNumber.confidence, 'low', 'but flagged unreliable, not guessed as valid');
});

test('mapMrzToExtractionResult excludes issue date from the local overall-confidence rollup (approved design)', () => {
  // The valid specimen has no issue date (MRZ never carries one) but all
  // other critical fields are checksum-valid — overall must not be
  // penalized to "low" just because issue date is structurally absent.
  const extraction = mapMrzToExtractionResult(parseValid(), VALID_SPECIMEN_LINES);
  assert.notEqual(extraction.overallConfidence, 'low');
});

test('buildUnreadableMrzResult returns an all-null, low-confidence result for unparseable OCR output', () => {
  const extraction = buildUnreadableMrzResult(['GARBAGE', 'NOT AN MRZ']);

  assert.equal(extraction.overallConfidence, 'low');
  assert.equal(extraction.firstName.value, null);
  assert.equal(extraction.surname.value, null);
  assert.equal(extraction.passportNumber.value, null);
  assert.equal(extraction.dateOfBirth.value, null);
  // The raw (unreliable) OCR text is preserved for human review — that's
  // what was actually read, not a guess.
  assert.equal(extraction.mrz.value, 'GARBAGE\nNOT AN MRZ');
  assert.equal(extraction.mrz.confidence, 'low');
});

test('buildUnreadableMrzResult handles completely empty OCR output', () => {
  const extraction = buildUnreadableMrzResult([]);
  assert.deepEqual(extraction.mrz, { value: null, confidence: null });
  assert.equal(extraction.overallConfidence, 'low');
});

test('mapMrzToExtractionResult reports the caller-supplied model string instead of the local/Tesseract default, when given one', () => {
  const extraction = mapMrzToExtractionResult(parseValid(), VALID_SPECIMEN_LINES, 'google-vision-mrz');
  assert.equal(extraction.model, 'google-vision-mrz');
});

test('buildUnreadableMrzResult reports the caller-supplied model string instead of the local/Tesseract default, when given one', () => {
  const extraction = buildUnreadableMrzResult([], 'google-vision-mrz');
  assert.equal(extraction.model, 'google-vision-mrz');
});

// --- visualIssueDate parameter -----------------------------------------
// Google Vision's structured word/bounding-box data can recover
// passport_issue_date outside the MRZ (which structurally never carries it)
// — a caller supplies the already-extracted, already-validated ISO date
// string (or null) as a 4th parameter, rather than this function trying to
// find it itself.

test('mapMrzToExtractionResult populates passportIssueDate with medium confidence when a visualIssueDate is supplied', () => {
  const extraction = mapMrzToExtractionResult(parseValid(), VALID_SPECIMEN_LINES, 'tesseract-mrz-local', '2020-01-15');
  assert.deepEqual(extraction.passportIssueDate, { value: '2020-01-15', confidence: 'medium' });
});

test('mapMrzToExtractionResult never assigns high confidence to a visual issue date — it has no MRZ check digit to verify it against', () => {
  const extraction = mapMrzToExtractionResult(parseValid(), VALID_SPECIMEN_LINES, 'tesseract-mrz-local', '2020-01-15');
  assert.notEqual(extraction.passportIssueDate.confidence, 'high');
});

test('mapMrzToExtractionResult keeps passportIssueDate null when visualIssueDate is omitted (fully backward compatible)', () => {
  const extraction = mapMrzToExtractionResult(parseValid(), VALID_SPECIMEN_LINES);
  assert.deepEqual(extraction.passportIssueDate, { value: null, confidence: null });
});

test('mapMrzToExtractionResult keeps passportIssueDate null when visualIssueDate is explicitly null', () => {
  const extraction = mapMrzToExtractionResult(parseValid(), VALID_SPECIMEN_LINES, 'tesseract-mrz-local', null);
  assert.deepEqual(extraction.passportIssueDate, { value: null, confidence: null });
});

test('mapMrzToExtractionResult still excludes issue date from the overall-confidence rollup even when a visualIssueDate is supplied (approved design — a structural add-on should not change the local-provider confidence contract)', () => {
  const extraction = mapMrzToExtractionResult(parseValid(), VALID_SPECIMEN_LINES, 'tesseract-mrz-local', '2020-01-15');
  assert.notEqual(extraction.overallConfidence, 'low');
});
