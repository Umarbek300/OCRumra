import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractDateCandidates } from '../src/ocr/visual/extractDateCandidates.js';
import { inferIssueDate } from '../src/ocr/visual/inferIssueDate.js';

/**
 * extractDateCandidates()/inferIssueDate() are pure string/array functions
 * with no OCR-engine dependency (confirmed by reading their source: neither
 * imports anything Tesseract-specific). These tests characterize that they
 * work correctly on a single, realistic Google Vision documentTextDetection()
 * `fullText` blob — the visual (non-MRZ) zone AND the MRZ zone concatenated
 * into one multi-line string, exactly the shape Vision's fullTextAnnotation
 * returns for a passport photo in one API call. No second OCR call, no
 * Tesseract-specific fixture shape anywhere in this file.
 */

const REALISTIC_VISION_FULL_TEXT = [
  'REPUBLIC OF EXAMPLIA',
  'PASSPORT',
  'Type/Code/No',
  'P EXM AB1234567',
  'Surname',
  'DOE',
  'Given Names',
  'JOHN',
  'Nationality',
  'EXAMPLIAN',
  'Date of birth',
  '12 MAY 1990',
  'Sex',
  'M',
  'Place of birth',
  'EXAMPLE CITY',
  'Date of issue',
  '15 JAN 2020',
  'Date of expiry',
  '15 JAN 2030',
  'Issuing Authority',
  'MINISTRY OF FOREIGN AFFAIRS',
  'P<EXMDOE<<JOHN<<<<<<<<<<<<<<<<<<<<<<<<<<<<<',
  'AB12345670EXM9005125M3001158<<<<<<<<<<<<<<08',
].join('\n');

const KNOWN_MRZ_DATES = ['1990-05-12', '2030-01-15']; // dateOfBirth, passportExpiryDate — as MRZ would supply them

test('extractDateCandidates finds all visual-zone dates in a realistic combined (visual + MRZ) fullText blob', () => {
  const candidates = extractDateCandidates(REALISTIC_VISION_FULL_TEXT);
  assert.deepEqual([...candidates].sort(), ['1990-05-12', '2020-01-15', '2030-01-15']);
});

test('extractDateCandidates does not produce false-positive candidates from the raw MRZ lines themselves', () => {
  const mrzOnly = [
    'P<EXMDOE<<JOHN<<<<<<<<<<<<<<<<<<<<<<<<<<<<<',
    'AB12345670EXM9005125M3001158<<<<<<<<<<<<<<08',
  ].join('\n');
  // MRZ's YYMMDD run (e.g. "900512") has no separators and no 4-digit year,
  // so it must not match any of the date patterns.
  assert.deepEqual(extractDateCandidates(mrzOnly), []);
});

test('inferIssueDate correctly isolates the issue date from a realistic combined fullText blob (end-to-end, provider-agnostic)', () => {
  const candidates = extractDateCandidates(REALISTIC_VISION_FULL_TEXT);
  const issueDate = inferIssueDate(candidates, KNOWN_MRZ_DATES);
  assert.equal(issueDate, '2020-01-15');
});

test('inferIssueDate stays null (never guesses) when the visual zone text is missing from fullText (MRZ-only read)', () => {
  const mrzOnlyFullText = [
    'P<EXMDOE<<JOHN<<<<<<<<<<<<<<<<<<<<<<<<<<<<<',
    'AB12345670EXM9005125M3001158<<<<<<<<<<<<<<08',
  ].join('\n');
  const candidates = extractDateCandidates(mrzOnlyFullText);
  assert.equal(inferIssueDate(candidates, KNOWN_MRZ_DATES), null);
});

test('inferIssueDate stays null (ambiguous) when the visual zone contains an extra unrelated date alongside the real issue date', () => {
  const textWithExtraDate = `${REALISTIC_VISION_FULL_TEXT}\nRenewed 01 JAN 2021`;
  const candidates = extractDateCandidates(textWithExtraDate);
  assert.equal(inferIssueDate(candidates, KNOWN_MRZ_DATES), null);
});
