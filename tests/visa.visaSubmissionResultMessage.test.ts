import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildVisaBatchSubmissionOperatorSummary } from '../src/visa/visaSubmissionResultMessage.js';
import type { VisaWorkerLoopResult } from '../src/visa/visaWorkerLoop.js';

/**
 * Package 5.42: pure, Telegram-free, DB-free, browser-free unit tests for
 * buildVisaBatchSubmissionOperatorSummary -- same "pure core" testing
 * convention as visaAttentionMessage.test.ts already established for its
 * own sibling module.
 */

test('Package 5.42: a plain SAVED outcome with NO detail is shown exactly as it always implicitly was -- no warning marker, no extra sentence', () => {
  const result: VisaWorkerLoopResult = {
    lockOutcome: 'acquired',
    batchValidation: { outcome: 'ok' },
    applicantOutcomes: [{ recordId: 'r1', outcome: 'SAVED' }],
  };

  const text = buildVisaBatchSubmissionOperatorSummary('26.10-1', result);

  assert.equal(text, "VisitSaudi topshirish natijasi -- Batch: 26.10-1\n1-o'rin: SAVED");
});

test('Package 5.42: a SAVED outcome WITH detail shows the caveat clearly, but never as a failure -- "SAVED" wording is never changed', () => {
  const result: VisaWorkerLoopResult = {
    lockOutcome: 'acquired',
    batchValidation: { outcome: 'ok' },
    applicantOutcomes: [
      {
        recordId: 'r1',
        outcome: 'SAVED',
        detail: 'hotel autocomplete suggestion was not found/selected; Page 5 (Insurance) did not appear -- insurance consent NOT confirmed',
      },
    ],
  };

  const text = buildVisaBatchSubmissionOperatorSummary('26.10-1', result);

  assert.match(text, /1-o'rin: SAVED\n\s+⚠️ hotel autocomplete suggestion was not found\/selected; Page 5 \(Insurance\) did not appear -- insurance consent NOT confirmed/);
  assert.doesNotMatch(text, /ERROR|FAILED|XATO/i, 'a SAVED-with-caveat applicant must never read as a failure');
});

test('Package 5.42: position numbers (N-o\'rin) follow applicantOutcomes\' own array order, 1-based, matching runVisaWorkerLoopForBatch\'s own order-preservation guarantee -- mixed SAVED-with-detail and plain SAVED never get mixed up', () => {
  const result: VisaWorkerLoopResult = {
    lockOutcome: 'acquired',
    batchValidation: { outcome: 'ok' },
    applicantOutcomes: [
      { recordId: 'r1', outcome: 'SAVED' },
      { recordId: 'r2', outcome: 'SAVED', detail: 'hotel autocomplete suggestion was not found/selected' },
      { recordId: 'r3', outcome: 'SAVED' },
    ],
  };

  const text = buildVisaBatchSubmissionOperatorSummary('26.10-1', result);
  const lines = text.split('\n');

  assert.ok(lines.some((l) => l === "1-o'rin: SAVED"));
  assert.ok(lines.some((l) => l === "2-o'rin: SAVED"));
  assert.ok(lines.some((l) => l.includes('hotel autocomplete suggestion was not found/selected')));
  assert.ok(lines.some((l) => l === "3-o'rin: SAVED"));
  // Only applicant #2 may carry the warning marker.
  assert.equal(lines.filter((l) => l.includes('⚠️')).length, 1);
});

test('Package 5.42: ERROR/AMBIGUOUS outcomes show their own existing detail unchanged', () => {
  const result: VisaWorkerLoopResult = {
    lockOutcome: 'acquired',
    batchValidation: { outcome: 'ok' },
    applicantOutcomes: [
      { recordId: 'r1', outcome: 'ERROR', detail: 'portal rejected the form' },
      { recordId: 'r2', outcome: 'AMBIGUOUS', detail: 'save click timed out' },
    ],
  };

  const text = buildVisaBatchSubmissionOperatorSummary('26.10-1', result);

  assert.match(text, /1-o'rin: ERROR\n\s+portal rejected the form/);
  assert.match(text, /2-o'rin: AMBIGUOUS\n\s+save click timed out/);
});

test('Package 5.42: reason-bearing outcomes (SKIPPED_NOT_CLAIMABLE, IDENTITY_MISMATCH, SKIPPED_PREFLIGHT_FAILED) show their own reason, and RECORD_NOT_FOUND (no detail/reason at all) never crashes', () => {
  const result: VisaWorkerLoopResult = {
    lockOutcome: 'acquired',
    batchValidation: { outcome: 'ok' },
    applicantOutcomes: [
      { recordId: 'r1', outcome: 'SKIPPED_NOT_CLAIMABLE', reason: 'already SAVED' },
      { recordId: 'r2', outcome: 'RECORD_NOT_FOUND' },
      { recordId: 'r3', outcome: 'IDENTITY_MISMATCH', reason: 'groupId mismatch' },
      { recordId: 'r4', outcome: 'SKIPPED_PREFLIGHT_FAILED', reason: 'missing passport scan' },
    ],
  };

  const text = buildVisaBatchSubmissionOperatorSummary('26.10-1', result);

  assert.match(text, /1-o'rin: SKIPPED_NOT_CLAIMABLE\n\s+already SAVED/);
  assert.match(text, /2-o'rin: RECORD_NOT_FOUND/);
  assert.match(text, /3-o'rin: IDENTITY_MISMATCH\n\s+groupId mismatch/);
  assert.match(text, /4-o'rin: SKIPPED_PREFLIGHT_FAILED\n\s+missing passport scan/);
});

test('Package 5.42: an already-locked run is reported clearly, without iterating an empty applicantOutcomes list', () => {
  const result: VisaWorkerLoopResult = { lockOutcome: 'already-locked', applicantOutcomes: [] };

  const text = buildVisaBatchSubmissionOperatorSummary('26.10-1', result);

  assert.match(text, /already-locked|allaqachon ishlamoqda/i);
  assert.doesNotMatch(text, /o'rin:/);
});

test('Package 5.42: a rejected batch validation is reported clearly, with its own reason, without iterating applicantOutcomes', () => {
  const result: VisaWorkerLoopResult = {
    lockOutcome: 'acquired',
    batchValidation: { outcome: 'rejected', reason: 'the given applicants list has 9 entries, but the batch has 10' },
    applicantOutcomes: [],
  };

  const text = buildVisaBatchSubmissionOperatorSummary('26.10-1', result);

  assert.match(text, /the given applicants list has 9 entries, but the batch has 10/);
});

test('Package 5.42: an empty applicantOutcomes list (acquired + ok validation, but nothing to process) is reported clearly, not as an empty/blank message', () => {
  const result: VisaWorkerLoopResult = { lockOutcome: 'acquired', batchValidation: { outcome: 'ok' }, applicantOutcomes: [] };

  const text = buildVisaBatchSubmissionOperatorSummary('26.10-1', result);

  assert.match(text, /topilmadi|hech/i);
});
