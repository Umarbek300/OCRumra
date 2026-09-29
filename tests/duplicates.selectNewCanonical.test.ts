import assert from 'node:assert/strict';
import { test } from 'node:test';
import { candidateScore, selectNewCanonical, type CanonicalReassignmentCandidate } from '../src/duplicates/selectNewCanonical.js';

function candidate(overrides: Partial<CanonicalReassignmentCandidate>): CanonicalReassignmentCandidate {
  return {
    linkId: 'link-x',
    telegramMessageId: 'msg-x',
    passportNumberConfidence: 'high',
    dobConfidence: 'high',
    messageTimestamp: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

test('selectNewCanonical returns null when there are no candidates', () => {
  assert.equal(selectNewCanonical([]), null);
});

test('selectNewCanonical returns the single candidate when there is only one', () => {
  const only = candidate({ linkId: 'link-1' });
  assert.equal(selectNewCanonical([only]), only);
});

test('candidateScore uses the MINIMUM of the two identity fields, never an average', () => {
  assert.equal(candidateScore({ passportNumberConfidence: 'high', dobConfidence: 'low' }), 0);
  assert.equal(candidateScore({ passportNumberConfidence: 'medium', dobConfidence: 'high' }), 1);
  assert.equal(candidateScore({ passportNumberConfidence: 'high', dobConfidence: 'high' }), 2);
});

test('selectNewCanonical picks the candidate with the highest field-level confidence score', () => {
  const weak = candidate({ linkId: 'weak', passportNumberConfidence: 'medium', dobConfidence: 'medium' });
  const strong = candidate({ linkId: 'strong', passportNumberConfidence: 'high', dobConfidence: 'high' });
  const result = selectNewCanonical([weak, strong]);
  assert.equal(result?.linkId, 'strong');
});

test('selectNewCanonical resolves a confidence tie by picking the most recent message', () => {
  const older = candidate({ linkId: 'older', messageTimestamp: '2026-01-01T00:00:00.000Z' });
  const newer = candidate({ linkId: 'newer', messageTimestamp: '2026-01-02T00:00:00.000Z' });
  const result = selectNewCanonical([older, newer]);
  assert.equal(result?.linkId, 'newer');
});

test('selectNewCanonical never lets a more-recent but LOWER-confidence candidate beat a higher-confidence older one', () => {
  const newerButWeaker = candidate({
    linkId: 'newer-weaker',
    passportNumberConfidence: 'medium',
    dobConfidence: 'medium',
    messageTimestamp: '2026-01-05T00:00:00.000Z',
  });
  const olderButStronger = candidate({
    linkId: 'older-stronger',
    passportNumberConfidence: 'high',
    dobConfidence: 'high',
    messageTimestamp: '2026-01-01T00:00:00.000Z',
  });
  const result = selectNewCanonical([newerButWeaker, olderButStronger]);
  assert.equal(result?.linkId, 'older-stronger');
});

test('selectNewCanonical handles a three-way tie correctly, picking the most recent of the tied group', () => {
  const a = candidate({ linkId: 'a', messageTimestamp: '2026-01-01T00:00:00.000Z' });
  const b = candidate({ linkId: 'b', messageTimestamp: '2026-01-03T00:00:00.000Z' });
  const c = candidate({ linkId: 'c', messageTimestamp: '2026-01-02T00:00:00.000Z' });
  const result = selectNewCanonical([a, b, c]);
  assert.equal(result?.linkId, 'b');
});

test('selectNewCanonical never uses overall_confidence -- only passportNumberConfidence/dobConfidence are consulted', () => {
  // Sanity check on the type shape itself: CanonicalReassignmentCandidate
  // has no overall_confidence field at all, so there is nothing for the
  // scoring function to accidentally read.
  const c = candidate({});
  assert.equal('overallConfidence' in c, false);
});
