import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canTransition, mapSubmissionStatusToSheetValue, VISA_SUBMISSION_STATUSES } from '../src/visa/visaSubmissionStatus.js';

const ALLOWED: ReadonlyArray<[string, string]> = [
  ['PENDING', 'SUBMITTING'],
  ['SUBMITTING', 'SAVED'],
  ['SUBMITTING', 'ERROR'],
  ['SUBMITTING', 'AMBIGUOUS'],
];

for (const [from, to] of ALLOWED) {
  test(`allowed transition: ${from} -> ${to}`, () => {
    assert.deepEqual(canTransition(from, to), { ok: true });
  });
}

const FORBIDDEN: ReadonlyArray<[string, string]> = [
  ['PENDING', 'SAVED'],
  ['PENDING', 'ERROR'],
  ['PENDING', 'AMBIGUOUS'],
  ['PENDING', 'PENDING'],
  ['SUBMITTING', 'PENDING'], // the one the business rule explicitly forbids -- never auto-revert a stale claim to PENDING
  ['SUBMITTING', 'SUBMITTING'],
  ['SAVED', 'PENDING'],
  ['SAVED', 'SUBMITTING'],
  ['SAVED', 'ERROR'],
  ['SAVED', 'AMBIGUOUS'],
  ['ERROR', 'PENDING'], // retry policy is out of scope for this phase -- no automatic way out of ERROR yet
  ['ERROR', 'SUBMITTING'],
  ['AMBIGUOUS', 'PENDING'], // never auto-resubmitted
  ['AMBIGUOUS', 'SAVED'],
  ['AMBIGUOUS', 'SUBMITTING'],
];

for (const [from, to] of FORBIDDEN) {
  test(`forbidden transition: ${from} -> ${to}`, () => {
    const result = canTransition(from, to);
    assert.equal(result.ok, false);
    if (result.ok) throw new Error('unreachable');
    assert.equal(result.reason, 'FORBIDDEN_TRANSITION');
  });
}

test('an invalid current status is rejected with its own distinct reason', () => {
  const result = canTransition('NOT_A_REAL_STATUS', 'SUBMITTING');
  assert.deepEqual(result, { ok: false, reason: 'INVALID_CURRENT_STATUS' });
});

test('an invalid next status is rejected with its own distinct reason', () => {
  const result = canTransition('PENDING', 'NOT_A_REAL_STATUS');
  assert.deepEqual(result, { ok: false, reason: 'INVALID_NEXT_STATUS' });
});

test('every declared status has at least a defined (possibly empty) transition entry -- exhaustiveness sanity check', () => {
  for (const status of VISA_SUBMISSION_STATUSES) {
    // canTransition(status, status) must always resolve to a deterministic
    // answer (true or FORBIDDEN_TRANSITION), never INVALID_CURRENT_STATUS,
    // proving `status` itself is always recognized as valid.
    const result = canTransition(status, status);
    assert.notEqual((result.ok ? undefined : result.reason), 'INVALID_CURRENT_STATUS');
  }
});

test('mapSubmissionStatusToSheetValue: PENDING and SUBMITTING both show as PENDING on the Sheet', () => {
  assert.equal(mapSubmissionStatusToSheetValue('PENDING'), 'PENDING');
  assert.equal(mapSubmissionStatusToSheetValue('SUBMITTING'), 'PENDING');
});

test('mapSubmissionStatusToSheetValue: SAVED and ERROR map directly', () => {
  assert.equal(mapSubmissionStatusToSheetValue('SAVED'), 'SAVED');
  assert.equal(mapSubmissionStatusToSheetValue('ERROR'), 'ERROR');
});

test('mapSubmissionStatusToSheetValue: AMBIGUOUS has deliberately NO safe mapping -- never guessed as PENDING/SAVED/ERROR', () => {
  assert.equal(mapSubmissionStatusToSheetValue('AMBIGUOUS'), 'NO_SAFE_SHEET_MAPPING');
});
