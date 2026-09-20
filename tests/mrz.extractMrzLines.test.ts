import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractMrzLines } from '../src/ocr/mrz/extractMrzLines.js';
import { parseAndValidateMrz } from '../src/ocr/mrz/parseAndValidateMrz.js';

test('extractMrzLines strips stray internal whitespace and uppercases', () => {
  const raw = 'P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<\nl898902c3 6uto740812 2f1204159ze184226b<<<<<10';
  const lines = extractMrzLines(raw);
  assert.equal(lines.length, 2);
  assert.equal(lines[1], 'L898902C36UTO7408122F1204159ZE184226B<<<<<10');
});

test('extractMrzLines drops blank lines and keeps only the last two non-blank lines', () => {
  const raw = '\n\nsome preamble tesseract sometimes emits\n\nP<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<\nL898902C36UTO7408122F1204159ZE184226B<<<<<10\n\n';
  const lines = extractMrzLines(raw);
  assert.deepEqual(lines, ['P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<', 'L898902C36UTO7408122F1204159ZE184226B<<<<<10']);
});

test('extractMrzLines returns fewer than 2 lines when OCR output is empty or sparse (caller treats as unreadable)', () => {
  assert.deepEqual(extractMrzLines(''), []);
  assert.deepEqual(extractMrzLines('\n\n'), []);
  assert.deepEqual(extractMrzLines('ONLYONELINE'), ['ONLYONELINE']);
});

test('extractMrzLines trims an excess trailing filler character, recovering a parseable, checksum-valid MRZ', () => {
  // Reproduces what production actually saw: a real 44-char line plus one
  // extra OCR-artifact trailing '<' (45 chars total) on the second line.
  const raw = 'P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<\nL898902C36UTO7408122F1204159ZE184226B<<<<<10<';
  const lines = extractMrzLines(raw);

  assert.equal(lines[1]?.length, 44);

  const parsed = parseAndValidateMrz(lines);
  assert.ok(parsed, 'a 45-char line with one excess trailing filler must now parse successfully');
  assert.equal(parsed.format, 'TD3');
  assert.equal(parsed.fields.documentNumber, 'L898902C3');
  const documentNumberCheck = parsed.details.find((detail) => detail.field === 'documentNumberCheckDigit');
  assert.equal(documentNumberCheck?.valid, true);
});
