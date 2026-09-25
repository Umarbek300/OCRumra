import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAndValidateMrz } from '../src/ocr/mrz/parseAndValidateMrz.js';

// The well-known ICAO Doc 9303 Part 4 specimen MRZ (fictitious "Anna Maria
// Eriksson", document number L898902C3, country code "UTO" = Utopia — the
// standard example used throughout the MRZ spec and virtually every MRZ
// library's own test suite). Not real passport data.
const VALID_SPECIMEN_LINES = ['P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<', 'L898902C36UTO7408122F1204159ZE184226B<<<<<10'];

test('parseAndValidateMrz parses a well-formed TD3 MRZ and validates its check digits', () => {
  const result = parseAndValidateMrz(VALID_SPECIMEN_LINES);
  assert.ok(result);
  assert.equal(result.format, 'TD3');
  assert.equal(result.fields.documentNumber, 'L898902C3');
  assert.equal(result.fields.lastName, 'ERIKSSON');
  assert.equal(result.fields.firstName, 'ANNA MARIA');
  assert.equal(result.fields.sex, 'female');
  assert.equal(result.fields.birthDate, '740812');
  assert.equal(result.fields.expirationDate, '120415');

  const documentNumberCheck = result.details.find((detail) => detail.field === 'documentNumberCheckDigit');
  const birthDateCheck = result.details.find((detail) => detail.field === 'birthDateCheckDigit');
  const expirationDateCheck = result.details.find((detail) => detail.field === 'expirationDateCheckDigit');
  assert.equal(documentNumberCheck?.valid, true);
  assert.equal(birthDateCheck?.valid, true);
  assert.equal(expirationDateCheck?.valid, true);
});

test('parseAndValidateMrz autocorrects a common OCR digit/letter confusion without changing check-digit validity', () => {
  // Reproduces exactly what real Tesseract OCR produced in local prototyping
  // on this same specimen: the "O" in issuing/nationality code "UTO" misread as "0".
  const ocrLinesWithMisread = ['P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<', 'L898902C36UT07408122F1204159ZE184226B<<<<<10'];
  const result = parseAndValidateMrz(ocrLinesWithMisread);
  assert.ok(result);
  // Autocorrected back to the checksum/format-valid reading — not invented,
  // just resolved: only "O" is a valid letter in that position, "0" isn't.
  const nationalityDetail = result.details.find((detail) => detail.field === 'nationality');
  assert.equal(nationalityDetail?.autocorrect[0]?.original, '0');
  assert.equal(nationalityDetail?.autocorrect[0]?.corrected, 'O');
});

test('parseAndValidateMrz flags an invalid document-number check digit instead of silently accepting it', () => {
  // Last digit of line 2 changed: check digit 6 -> 5 (deliberately wrong).
  const corrupted = ['P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<', 'L898902C35UTO7408122F1204159ZE184226B<<<<<10'];
  const result = parseAndValidateMrz(corrupted);
  assert.ok(result);
  assert.equal(result.valid, false);
  const documentNumberCheck = result.details.find((detail) => detail.field === 'documentNumberCheckDigit');
  assert.equal(documentNumberCheck?.valid, false);
});

test('parseAndValidateMrz returns null (never throws) for input that is not a recognizable MRZ shape', () => {
  assert.equal(parseAndValidateMrz(['too short', 'also too short']), null);
  assert.equal(parseAndValidateMrz(['only one line of the wrong length']), null);
  assert.equal(parseAndValidateMrz([]), null);
});

// ---------------------------------------------------------------------------
// Explicit characterization of the three outcomes parseAndValidateMrz()'s
// callers must distinguish: `null` (structurally unrecognizable — see above),
// `result.valid === false` (structurally fine, checksum(s) wrong), and
// `result.valid === true` (genuinely valid). Written for a specific reason:
// the "well-formed TD3 MRZ" test above never actually asserts
// `result.valid === true` at the top level — it only checks individual
// field validity — and the fictitious ICAO specimen country code ("UTO",
// not a real ISO code) in fact makes `result.valid` false overall (the
// `mrz` package validates country codes against a real-country list). A
// real ISO code ("USA") is swapped in below purely to get a genuinely
// `valid: true` result to characterize against — it changes nothing
// checksum-related, since country code isn't part of any check-digit
// calculation.
// ---------------------------------------------------------------------------

const REAL_COUNTRY_SPECIMEN_LINES = [
  'P<USAERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<',
  'L898902C36USA7408122F1204159ZE184226B<<<<<10',
];

test('characterization: parseAndValidateMrz returns null for a structurally unrecognizable pair', () => {
  const result = parseAndValidateMrz(['P<TOO<SHORT', 'ALSO<TOO<SHORT']);
  assert.equal(result, null);
});

test('characterization: parseAndValidateMrz returns a non-null result with valid=false for a structurally correct but checksum-wrong pair', () => {
  const corruptedCheckDigit = ['P<USAERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<', 'L898902C35USA7408122F1204159ZE184226B<<<<<10'];
  const result = parseAndValidateMrz(corruptedCheckDigit);
  assert.ok(result !== null);
  assert.equal(result.valid, false);
});

test('characterization: parseAndValidateMrz returns a non-null result with valid=true for a genuinely well-formed, checksum-correct pair', () => {
  const result = parseAndValidateMrz(REAL_COUNTRY_SPECIMEN_LINES);
  assert.ok(result !== null);
  assert.equal(result.valid, true);
});

test('characterization: a genuinely valid TD3 line 2 with a fully-used optional personal-number field (zero "<" filler characters anywhere) still validates as valid=true — the exact structural shape real Google Vision reads produced for real messages 270/271', () => {
  // Independently computed (ICAO 9303 check-digit algorithm: weights
  // 7/3/1 cycling, '<' = 0, digits = their value, letters = 10-35) — not
  // copied from any real document. Structurally identical in shape to
  // what Vision read for 270/271 (44 chars, valid MRZ alphabet, zero
  // filler in line 2), but built from placeholder values.
  const line1 = 'P<USAERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<';
  const line2NoFillerButValid = 'L898902C36USA7408122F1204159ZE184226B1234508';
  assert.equal(line2NoFillerButValid.length, 44);
  assert.equal(line2NoFillerButValid.includes('<'), false);

  const result = parseAndValidateMrz([line1, line2NoFillerButValid]);

  assert.ok(result !== null);
  assert.equal(result.valid, true);
});
