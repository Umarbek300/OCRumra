import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ClaudePassportResponseSchema,
  computeOverallConfidence,
  IsoDateStringSchema,
  type ClaudePassportResponse,
} from '../src/ocr/passportExtractionSchema.js';

function field(value: string | null, confidence: 'high' | 'medium' | 'low' | null) {
  return { value, confidence };
}

function genderField(value: 'male' | 'female' | 'unspecified' | null, confidence: 'high' | 'medium' | 'low' | null) {
  return { value, confidence };
}

function fullResponse(overrides: Partial<ClaudePassportResponse> = {}): ClaudePassportResponse {
  const base: ClaudePassportResponse = {
    firstName: field('Jane', 'high'),
    middleName: field(null, null),
    surname: field('Doe', 'high'),
    passportNumber: field('X1234567', 'high'),
    dateOfBirth: field('1990-05-15', 'high'),
    passportIssueDate: field('2020-01-01', 'high'),
    passportExpiryDate: field('2030-01-01', 'high'),
    gender: genderField('female', 'high'),
    nationality: field('UZB', 'high'),
    placeOfBirth: field(null, null),
    issuingAuthority: field(null, null),
    mrz: field(null, null),
  };
  return { ...base, ...overrides };
}

test('IsoDateStringSchema accepts a real calendar date in YYYY-MM-DD', () => {
  assert.equal(IsoDateStringSchema.safeParse('2024-02-29').success, true); // leap year
});

test('IsoDateStringSchema rejects a wrong-format date', () => {
  assert.equal(IsoDateStringSchema.safeParse('29/02/2024').success, false);
});

test('IsoDateStringSchema rejects an impossible calendar date', () => {
  assert.equal(IsoDateStringSchema.safeParse('2023-02-29').success, false); // not a leap year
  assert.equal(IsoDateStringSchema.safeParse('2024-13-01').success, false); // month 13
  assert.equal(IsoDateStringSchema.safeParse('2024-04-31').success, false); // April has 30 days
});

test('ClaudePassportResponseSchema accepts a fully-populated valid response', () => {
  const result = ClaudePassportResponseSchema.safeParse(fullResponse());
  assert.equal(result.success, true);
});

test('ClaudePassportResponseSchema accepts null values for unreadable fields', () => {
  const result = ClaudePassportResponseSchema.safeParse(
    fullResponse({ passportNumber: field(null, null), mrz: field(null, null) }),
  );
  assert.equal(result.success, true);
});

test('ClaudePassportResponseSchema rejects a missing required key', () => {
  const response = fullResponse() as Partial<ClaudePassportResponse>;
  delete response.passportNumber;
  const result = ClaudePassportResponseSchema.safeParse(response);
  assert.equal(result.success, false);
});

test('ClaudePassportResponseSchema rejects an invalid date format inside a field', () => {
  const result = ClaudePassportResponseSchema.safeParse(fullResponse({ dateOfBirth: field('15-05-1990', 'high') }));
  assert.equal(result.success, false);
});

test('ClaudePassportResponseSchema rejects an invalid gender value', () => {
  const response = fullResponse() as unknown as Record<string, unknown>;
  response.gender = field('other', 'high');
  const result = ClaudePassportResponseSchema.safeParse(response);
  assert.equal(result.success, false);
});

test('computeOverallConfidence is high when every critical field is present and high-confidence', () => {
  assert.equal(computeOverallConfidence(fullResponse()), 'high');
});

test('computeOverallConfidence downgrades to the weakest critical field confidence', () => {
  assert.equal(computeOverallConfidence(fullResponse({ surname: field('Doe', 'medium') })), 'medium');
  assert.equal(computeOverallConfidence(fullResponse({ passportNumber: field('X1234567', 'low') })), 'low');
});

test('computeOverallConfidence forces low when a critical field value is null, regardless of other fields', () => {
  const response = fullResponse({ passportNumber: field(null, null) });
  assert.equal(computeOverallConfidence(response), 'low');
});

test('computeOverallConfidence never looks at non-critical fields', () => {
  // mrz/placeOfBirth/issuingAuthority/middleName are null in the base fixture
  // already, and all critical fields are high — result must still be high.
  assert.equal(computeOverallConfidence(fullResponse()), 'high');
});
