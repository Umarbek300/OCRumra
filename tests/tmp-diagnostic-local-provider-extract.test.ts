import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  formatLocalProviderExtractDiagnosticResult,
  runLocalProviderExtractDiagnostic,
} from '../scripts/tmp-diagnostic-local-provider-extract.js';
import type { PassportExtractionResult } from '../src/ocr/passportExtractionSchema.js';

function makeSuccessResult(): PassportExtractionResult {
  return {
    firstName: { value: 'ANNA', confidence: 'medium' },
    middleName: { value: 'MARIA', confidence: 'medium' },
    surname: { value: 'ERIKSSON', confidence: 'medium' },
    passportNumber: { value: 'L898902C3', confidence: 'high' },
    dateOfBirth: { value: '1974-08-12', confidence: 'high' },
    passportIssueDate: { value: null, confidence: null },
    passportExpiryDate: { value: '2012-04-15', confidence: 'high' },
    gender: { value: 'female', confidence: 'medium' },
    nationality: { value: 'UTO', confidence: 'medium' },
    placeOfBirth: { value: null, confidence: null },
    issuingAuthority: { value: 'UTO', confidence: 'medium' },
    mrz: {
      value: 'P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<\nL898902C36UTO7408122F1204159ZE184226B<<<<<10',
      confidence: 'high',
    },
    overallConfidence: 'high',
    model: 'tesseract-mrz-local',
  };
}

function makeUnreadableResult(): PassportExtractionResult {
  return {
    firstName: { value: null, confidence: null },
    middleName: { value: null, confidence: null },
    surname: { value: null, confidence: null },
    passportNumber: { value: null, confidence: null },
    dateOfBirth: { value: null, confidence: null },
    passportIssueDate: { value: null, confidence: null },
    passportExpiryDate: { value: null, confidence: null },
    gender: { value: null, confidence: null },
    nationality: { value: null, confidence: null },
    placeOfBirth: { value: null, confidence: null },
    issuingAuthority: { value: null, confidence: null },
    mrz: { value: 'garbageline\nanothergarbage', confidence: 'low' },
    overallConfidence: 'low',
    model: 'tesseract-mrz-local',
  };
}

test('runLocalProviderExtractDiagnostic reports presence/confidence for every field without the field values', async () => {
  const result = await runLocalProviderExtractDiagnostic(Buffer.from(''), async () => makeSuccessResult());

  assert.strictEqual(result.overallConfidence, 'high');
  assert.strictEqual(result.model, 'tesseract-mrz-local');
  assert.strictEqual(result.fields.firstName.present, true);
  assert.strictEqual(result.fields.firstName.confidence, 'medium');
  assert.strictEqual(result.fields.passportNumber.present, true);
  assert.strictEqual(result.fields.passportNumber.confidence, 'high');
  assert.strictEqual(result.fields.passportIssueDate.present, false);
  assert.strictEqual(result.fields.mrz.present, true);
});

test('runLocalProviderExtractDiagnostic marks every field absent for an unreadable MRZ result (except the raw mrz text slot)', async () => {
  const result = await runLocalProviderExtractDiagnostic(Buffer.from(''), async () => makeUnreadableResult());

  assert.strictEqual(result.overallConfidence, 'low');
  for (const [name, field] of Object.entries(result.fields)) {
    if (name === 'mrz') continue;
    assert.strictEqual(field.present, false, `expected ${name} to be absent`);
  }
  assert.strictEqual(result.fields.mrz.present, true, 'raw OCR text is kept structurally, even though unreadable');
});

test('runLocalProviderExtractDiagnostic reports a non-negative processing time', async () => {
  const result = await runLocalProviderExtractDiagnostic(Buffer.from(''), async () => makeSuccessResult());
  assert.ok(result.processingTimeMs >= 0);
});

test('formatLocalProviderExtractDiagnosticResult never includes actual field values, MRZ text, name, or passport number', async () => {
  const successResult = makeSuccessResult();
  const result = await runLocalProviderExtractDiagnostic(Buffer.from(''), async () => successResult);
  const formatted = formatLocalProviderExtractDiagnosticResult(result);

  assert.ok(!formatted.includes('ANNA'));
  assert.ok(!formatted.includes('ERIKSSON'));
  assert.ok(!formatted.includes('L898902C3'));
  assert.ok(!formatted.includes('1974-08-12'));
  assert.ok(!formatted.includes('2012-04-15'));
  assert.ok(!formatted.includes(successResult.mrz.value!));
  assert.ok(formatted.includes('present='));
  assert.ok(formatted.includes('confidence='));
  assert.ok(formatted.includes('overallConfidence'));
});

test('formatLocalProviderExtractDiagnosticResult includes every schema field name', async () => {
  const result = await runLocalProviderExtractDiagnostic(Buffer.from(''), async () => makeSuccessResult());
  const formatted = formatLocalProviderExtractDiagnosticResult(result);

  for (const fieldName of Object.keys(result.fields)) {
    assert.ok(formatted.includes(fieldName), `expected formatted output to mention field "${fieldName}"`);
  }
});

test('runLocalProviderExtractDiagnostic calls extract exactly once with the given buffer', async () => {
  const buffer = Buffer.from('fake-image-bytes');
  let receivedBuffer: Buffer | null = null;
  let callCount = 0;

  await runLocalProviderExtractDiagnostic(buffer, async (b) => {
    callCount += 1;
    receivedBuffer = b;
    return makeSuccessResult();
  });

  assert.strictEqual(callCount, 1);
  assert.strictEqual(receivedBuffer, buffer);
});
