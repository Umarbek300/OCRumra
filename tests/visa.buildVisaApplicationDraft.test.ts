import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildVisaApplicationDraft } from '../src/visa/buildVisaApplicationDraft.js';
import type { VerifiedApplicantData } from '../src/visa/types.js';

function sampleData(): VerifiedApplicantData {
  return {
    firstName: 'JANE',
    surname: 'SMITH',
    passportNumber: 'CD9876543',
    dateOfBirth: '1995-05-15',
    passportIssueDate: '2021-03-01',
    passportExpiryDate: '2031-03-01',
    gender: 'Ayol',
    nationality: 'UZB',
    email: 'jane@example.com',
    arrivalDate: '2026-10-05',
    personalPhotoUrl: 'https://example.com/jane-photo.jpg',
    passportScanUrl: 'https://example.com/jane-scan.jpg',
  };
}

test('VisitSaudi draft never carries passportScanUrl', () => {
  const draft = buildVisaApplicationDraft(sampleData(), 'visitsaudi');
  assert.equal(draft.portal, 'visitsaudi');
  assert.equal('passportScanUrl' in draft, false, 'the key itself must not exist on a VisitSaudi draft');
});

test('KSA Visa draft carries passportScanUrl', () => {
  const draft = buildVisaApplicationDraft(sampleData(), 'ksavisa');
  assert.equal(draft.portal, 'ksavisa');
  assert.equal(draft.passportScanUrl, 'https://example.com/jane-scan.jpg');
});

test('Sheet values map correctly into the draft (VisitSaudi)', () => {
  const data = sampleData();
  const draft = buildVisaApplicationDraft(data, 'visitsaudi');
  assert.equal(draft.firstName, data.firstName);
  assert.equal(draft.surname, data.surname);
  assert.equal(draft.dateOfBirth, data.dateOfBirth);
  assert.equal(draft.gender, data.gender);
  assert.equal(draft.passportNumber, data.passportNumber);
  assert.equal(draft.passportIssueDate, data.passportIssueDate);
  assert.equal(draft.passportExpiryDate, data.passportExpiryDate);
  assert.equal(draft.nationality, data.nationality);
  assert.equal(draft.email, data.email);
  assert.equal(draft.arrivalDate, data.arrivalDate);
  assert.equal(draft.personalPhotoUrl, data.personalPhotoUrl);
});

test('Sheet values map correctly into the draft (KSA Visa), including passportScanUrl', () => {
  const data = sampleData();
  const draft = buildVisaApplicationDraft(data, 'ksavisa');
  assert.equal(draft.firstName, data.firstName);
  assert.equal(draft.passportScanUrl, data.passportScanUrl);
});
