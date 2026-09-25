import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  computeDateLikeNearMissStatistics,
  extractNonMrzText,
} from '../scripts/tmp-diagnostic-google-vision-visual-issue-date.js';

test('extractNonMrzText removes exactly the winning MRZ window lines and keeps the rest', () => {
  const fullText = ['Surname', 'DOE', 'Date of issue', '15 JAN 2020', 'P<EXMDOE<<JOHN<<<<', 'AB1234567EXM9005125'].join(
    '\n',
  );
  // The MRZ pair sits at cleaned-line indices 4 and 5 in this fixture.
  const nonMrz = extractNonMrzText(fullText, 4);
  assert.equal(nonMrz.includes('P<EXMDOE'), false);
  assert.equal(nonMrz.includes('AB1234567EXM9005125'), false);
  assert.equal(nonMrz.includes('SURNAME'), true);
  assert.equal(nonMrz.includes('DATEOFISSUE'), true);
});

test('computeDateLikeNearMissStatistics reports zero everywhere for text with no date-like structure at all', () => {
  const stats = computeDateLikeNearMissStatistics('SURNAME\nDOE\nGIVENNAMES\nJOHN\nNATIONALITY\nEXAMPLIAN');
  assert.deepEqual(stats, {
    nonMrzLineCount: 6,
    fourDigitYearCount: 0,
    monthTokenCount: 0,
    separatorDigitPatternCount: 0,
    regexShapeMatchCount: 0,
    validCandidateCount: 0,
    regexNearMissCount: 0,
  });
});

test('computeDateLikeNearMissStatistics counts a fully well-formed date as a valid candidate, not a near miss', () => {
  const stats = computeDateLikeNearMissStatistics('DATEOFISSUE\n15JAN2020');
  assert.equal(stats.validCandidateCount, 1);
  assert.equal(stats.regexNearMissCount, 0);
  assert.equal(stats.monthTokenCount, 1);
  assert.equal(stats.fourDigitYearCount, 1);
});

test('computeDateLikeNearMissStatistics counts a shape match rejected for an impossible calendar date as a near miss', () => {
  const stats = computeDateLikeNearMissStatistics('DATEOFISSUE\n32.13.2020');
  assert.equal(stats.validCandidateCount, 0);
  assert.equal(stats.regexShapeMatchCount, 1);
  assert.equal(stats.regexNearMissCount, 1);
  assert.equal(stats.separatorDigitPatternCount, 1);
});

test('computeDateLikeNearMissStatistics counts a bare 4-digit year with no surrounding date shape', () => {
  const stats = computeDateLikeNearMissStatistics('ISSUED IN 2020 AT THE EMBASSY');
  assert.equal(stats.fourDigitYearCount, 1);
  assert.equal(stats.regexShapeMatchCount, 0);
  assert.equal(stats.validCandidateCount, 0);
  assert.equal(stats.regexNearMissCount, 0);
});

test('computeDateLikeNearMissStatistics counts a bare month token with no digits around it', () => {
  const stats = computeDateLikeNearMissStatistics('ISSUED IN JANUARY SOMEWHERE');
  // JAN is a substring of JANUARY, so the token pattern still finds it.
  assert.equal(stats.monthTokenCount, 1);
  assert.equal(stats.regexShapeMatchCount, 0);
});

test('computeDateLikeNearMissStatistics never includes the actual matched text, only counts', () => {
  const stats = computeDateLikeNearMissStatistics('DATEOFISSUE\n15JAN2020');
  const serialized = JSON.stringify(stats);
  assert.equal(serialized.includes('2020'), false);
  assert.equal(serialized.includes('JAN'), false);
});
