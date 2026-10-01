import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateVerifiedApplicantData } from '../src/visa/validateVerifiedApplicantData.js';
import type { VerifiedApplicantData } from '../src/visa/types.js';

function completeData(overrides: Partial<VerifiedApplicantData> = {}): VerifiedApplicantData {
  return {
    firstName: 'JOHN',
    surname: 'DOE',
    passportNumber: 'AB1234567',
    dateOfBirth: '1990-01-01',
    passportIssueDate: '2020-01-01',
    passportExpiryDate: '2030-01-01',
    gender: 'Erkak',
    nationality: 'UZB',
    email: 'john@example.com',
    arrivalDate: '2026-10-05',
    personalPhotoUrl: 'https://example.com/photo.jpg',
    passportScanUrl: 'https://example.com/scan.jpg',
    ...overrides,
  };
}

test('all fields complete -> ready (VisitSaudi)', () => {
  const result = validateVerifiedApplicantData(completeData(), 'visitsaudi');
  assert.deepEqual(result, { ready: true });
});

test('all fields complete -> ready (KSA Visa, with passport scan)', () => {
  const result = validateVerifiedApplicantData(completeData(), 'ksavisa');
  assert.deepEqual(result, { ready: true });
});

test('missing required field -> not ready (MISSING_FIELDS), names the Sheet column label', () => {
  const result = validateVerifiedApplicantData(completeData({ firstName: '' }), 'visitsaudi');
  assert.equal(result.ready, false);
  if (result.ready) throw new Error('unreachable');
  assert.equal(result.reason, 'MISSING_FIELDS');
  assert.ok(result.missingFields?.includes('Ism'));
});

test('whitespace-only field counts as missing', () => {
  const result = validateVerifiedApplicantData(completeData({ email: '   ' }), 'visitsaudi');
  assert.equal(result.ready, false);
  if (result.ready) throw new Error('unreachable');
  assert.equal(result.reason, 'MISSING_FIELDS');
});

test('invalid email -> not ready (INVALID_EMAIL)', () => {
  const result = validateVerifiedApplicantData(completeData({ email: 'not-an-email' }), 'visitsaudi');
  assert.deepEqual(result, { ready: false, reason: 'INVALID_EMAIL' });
});

test('invalid date of birth -> not ready (INVALID_DATE_OF_BIRTH)', () => {
  const result = validateVerifiedApplicantData(completeData({ dateOfBirth: '01/01/1990' }), 'visitsaudi');
  assert.deepEqual(result, { ready: false, reason: 'INVALID_DATE_OF_BIRTH' });
});

test('invalid passport issue date -> not ready (INVALID_ISSUE_DATE)', () => {
  const result = validateVerifiedApplicantData(completeData({ passportIssueDate: 'not-a-date' }), 'visitsaudi');
  assert.deepEqual(result, { ready: false, reason: 'INVALID_ISSUE_DATE' });
});

test('invalid passport expiry date -> not ready (INVALID_EXPIRY_DATE)', () => {
  const result = validateVerifiedApplicantData(completeData({ passportExpiryDate: 'not-a-date' }), 'visitsaudi');
  assert.deepEqual(result, { ready: false, reason: 'INVALID_EXPIRY_DATE' });
});

test('expired passport (valid date, but in the past) -> not ready (PASSPORT_EXPIRED)', () => {
  const result = validateVerifiedApplicantData(completeData({ passportExpiryDate: '2000-01-01' }), 'visitsaudi');
  assert.deepEqual(result, { ready: false, reason: 'PASSPORT_EXPIRED' });
});

test('invalid personal photo URL -> not ready (INVALID_PHOTO_URL)', () => {
  const result = validateVerifiedApplicantData(completeData({ personalPhotoUrl: 'not a url' }), 'visitsaudi');
  assert.deepEqual(result, { ready: false, reason: 'INVALID_PHOTO_URL' });
});

test('VisitSaudi never requires passport scan URL, even when blank', () => {
  const result = validateVerifiedApplicantData(completeData({ passportScanUrl: '' }), 'visitsaudi');
  assert.deepEqual(result, { ready: true });
});

test('KSA Visa missing passport scan URL -> not ready (MISSING_FIELDS)', () => {
  const result = validateVerifiedApplicantData(completeData({ passportScanUrl: '' }), 'ksavisa');
  assert.equal(result.ready, false);
  if (result.ready) throw new Error('unreachable');
  assert.equal(result.reason, 'MISSING_FIELDS');
  assert.ok(result.missingFields?.includes('Pasport skani URL'));
});

test('KSA Visa invalid (non-http) passport scan URL -> not ready (INVALID_SCAN_URL)', () => {
  const result = validateVerifiedApplicantData(completeData({ passportScanUrl: 'ftp://example.com/scan.jpg' }), 'ksavisa');
  assert.deepEqual(result, { ready: false, reason: 'INVALID_SCAN_URL' });
});
