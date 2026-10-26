import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pool } from '../src/db/pool.js';
import { assignVisaBatch } from '../src/visa/assignVisaBatch.js';
import { createPassportIdentity } from '../src/db/repositories/passportIdentity.repo.js';
import { createQueueForBatch, createSubmissionAttempt, finalizeSubmission } from '../src/db/repositories/visaSubmissionQueue.repo.js';
import { buildPostgresVisaBatchLockStore, buildPostgresVisaSubmissionQueueStore } from '../src/visa/visaSubmissionQueuePostgresStore.js';
import { findActiveApplicantPositionsForBatch } from '../src/db/repositories/visaBatches.repo.js';
import { claimApplicantForSubmission, recoverStaleSubmittingToAmbiguous } from '../src/visa/visaSubmissionQueueOrchestrator.js';
import { runVisaWorkerLoopForBatch, type VisaWorkerLoopDependencies } from '../src/visa/visaWorkerLoop.js';
import { buildMockVisaApplicantAutomationAdapter } from '../src/visa/mockVisaApplicantAutomationAdapter.js';
import type { VisaApplicantAutomationAdapter } from '../src/visa/visaApplicantAutomationAdapter.js';
import type { VisitSaudiPreflightResult } from '../src/visa/visitSaudiPreflight.js';
import type { VisitSaudiApplicationDraft } from '../src/visa/types.js';

// ============================================================================
// Test fixtures -- a minimal, deterministic VisitSaudiApplicationDraft and
// matching ready/not-ready VisitSaudiPreflightResult values, built by hand
// (never via the real, Sheet-reading checkVisitSaudiApplicantPreflight) so
// every test below can inject a trivial, network-free fake `checkPreflight`.
// ============================================================================

function buildFakeDraft(passportIdentityId: string): VisitSaudiApplicationDraft {
  return {
    portal: 'visitsaudi',
    firstName: 'Test',
    surname: 'Applicant',
    dateOfBirth: '1990-01-01',
    gender: 'male',
    passportNumber: `WORKERLOOP-${passportIdentityId.slice(0, 8)}`,
    passportIssueDate: '2020-01-01',
    passportExpiryDate: '2030-01-01',
    nationality: 'UZ',
    email: 'applicant@example.test',
    arrivalDate: '2026-12-01',
    personalPortraitUrl: 'https://example.test/portrait.jpg',
  };
}

/** Package 5.36: the extra fields VisaApplicantAutomationAdapter.submitApplicant now requires, reused by the direct-call unit tests below (buildFakeReadyPreflight already carries its own, equivalent values). */
const FAKE_PREFLIGHT_EXTRAS = {
  maritalStatus: 'SINGLE' as const,
  countryOfBirth: 'Uzbekistan',
  cityOfBirth: 'Tashkent',
  countryOfResidence: 'Uzbekistan',
  cityOfResidence: 'Tashkent',
  profession: 'WORKER' as const,
  expectedDateOfArrival: '2026-12-01',
  expectedDateOfDeparture: '2026-12-15',
};

function buildFakeReadyPreflight(passportIdentityId: string): VisitSaudiPreflightResult {
  return {
    passportIdentityId,
    sheetRowNumber: 2,
    ready: true,
    errors: [],
    draft: buildFakeDraft(passportIdentityId),
    expectedDateOfArrival: '2026-12-01',
    expectedDateOfDeparture: '2026-12-15',
    maritalStatus: 'SINGLE',
    countryOfBirth: 'Uzbekistan',
    cityOfBirth: 'Tashkent',
    countryOfResidence: 'Uzbekistan',
    cityOfResidence: 'Tashkent',
    profession: 'WORKER',
  };
}

function buildFakeNotReadyPreflight(passportIdentityId: string): VisitSaudiPreflightResult {
  return {
    passportIdentityId,
    sheetRowNumber: 2,
    ready: false,
    errors: [{ reason: 'MISSING_FIELDS', missingFields: ['Email'] }],
  };
}

/** Always resolves every applicant as ready -- the common case for most tests below. */
async function alwaysReadyPreflight(_groupId: string, passportIdentityId: string): Promise<VisitSaudiPreflightResult> {
  return buildFakeReadyPreflight(passportIdentityId);
}

/** Always resolves every applicant as NOT ready -- used by the preflight-failure test. */
async function alwaysNotReadyPreflight(_groupId: string, passportIdentityId: string): Promise<VisitSaudiPreflightResult> {
  return buildFakeNotReadyPreflight(passportIdentityId);
}

// ============================================================================
// DB fixtures -- same per-file-scoped unique-id convention as every other
// visa submission queue test file in this codebase (own idCounter, own
// group-name string), so this file's data can never collide with any other
// test file's.
// ============================================================================

let idCounter = 0;
function uniqueChatId(): number {
  idCounter += 1;
  return -1 * (Date.now() * 1000 + idCounter);
}
function uniquePassportNumber(): string {
  idCounter += 1;
  return `WORKERLOOPTEST${Date.now()}${idCounter}`;
}

async function createGroup(departureDate = '2026-12-01'): Promise<string> {
  const {
    rows: [group],
  } = await pool.query<{ id: string }>(
    `INSERT INTO groups (name, departure_date, telegram_chat_id) VALUES ($1, $2, $3) RETURNING id`,
    ['Visa Worker Loop Test Group', departureDate, uniqueChatId()],
  );
  assert.ok(group);
  return group.id;
}

async function createIdentity(): Promise<string> {
  const identity = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
  assert.ok(identity);
  return identity.id;
}

/** Creates one active applicant AND its PENDING queue row, returning everything a worker-loop test needs. */
async function createQueuedApplicant(
  groupId: string,
): Promise<{ recordId: string; batchId: string; passportIdentityId: string }> {
  const identityId = await createIdentity();
  const assignment = await assignVisaBatch(groupId, identityId, 'visitsaudi', '2026-12-01');
  const attempt = await createSubmissionAttempt(assignment.batchId, 'operator:test');
  const created = await createQueueForBatch(assignment.batchId, attempt.id);
  assert.ok(created && created.length >= 1);
  const record = created.find((r) => r.visaBatchApplicantId === assignment.id);
  assert.ok(record);
  return { recordId: record.id, batchId: assignment.batchId, passportIdentityId: identityId };
}

/** Creates `count` active applicants, all queued in the SAME batch, in creation (== position_in_batch) order -- same pattern test [12] already uses inline, factored out for the Package 5.1 hardening tests below. */
async function createMultiApplicantBatch(
  groupId: string,
  count: number,
): Promise<{ batchId: string; applicants: { recordId: string; passportIdentityId: string }[] }> {
  const identityIds: string[] = [];
  const assignments: Awaited<ReturnType<typeof assignVisaBatch>>[] = [];
  for (let i = 0; i < count; i += 1) {
    const identityId = await createIdentity();
    identityIds.push(identityId);
    assignments.push(await assignVisaBatch(groupId, identityId, 'visitsaudi', '2026-12-01'));
  }
  const batchId = assignments[0]!.batchId;
  assert.ok(assignments.every((a) => a.batchId === batchId));

  const attempt = await createSubmissionAttempt(batchId, 'operator:test');
  const created = await createQueueForBatch(batchId, attempt.id);
  assert.ok(created && created.length === count);

  const applicants = assignments.map((assignment, i) => {
    const record = created.find((r) => r.visaBatchApplicantId === assignment.id);
    assert.ok(record);
    return { recordId: record.id, passportIdentityId: identityIds[i]! };
  });
  return { batchId, applicants };
}

async function cleanupAll(groupIds: string[]): Promise<void> {
  for (const groupId of groupIds) {
    await pool.query(
      `DELETE FROM visa_operator_alerts WHERE visa_submission_queue_id IN (SELECT id FROM visa_submission_queue WHERE group_id = $1)`,
      [groupId],
    );
    await pool.query(`DELETE FROM visa_submission_queue WHERE group_id = $1`, [groupId]);
    await pool.query(`DELETE FROM visa_submission_attempts WHERE batch_id IN (SELECT id FROM visa_batches WHERE group_id = $1)`, [
      groupId,
    ]);
    await pool.query(`DELETE FROM visa_batch_processing_locks WHERE batch_id IN (SELECT id FROM visa_batches WHERE group_id = $1)`, [
      groupId,
    ]);
    await pool.query(`DELETE FROM visa_batch_applicants WHERE group_id = $1`, [groupId]);
    await pool.query(`DELETE FROM visa_batches WHERE group_id = $1`, [groupId]);
    await pool.query(
      `DELETE FROM passport_identity WHERE id IN (SELECT passport_identity_id FROM visa_batch_applicants WHERE group_id = $1)`,
      [groupId],
    );
    await pool.query(`DELETE FROM groups WHERE id = $1`, [groupId]);
  }
}

/**
 * Polls pg_blocking_pids (same documented, fact-based technique as the
 * identically-named helper in tests/visaSubmissionQueue.repo.test.ts) until
 * at least minCount DISTINCT backends are blocked TRANSITIVELY behind
 * blockerPid, returning the actual Set found. Used by the Package 5.8 race
 * test below against a lock the test ITSELF holds open indefinitely via a
 * separate, uncommitted transaction -- so there is no narrow timing window
 * to miss; the bounded timeout exists purely as a hang-guard.
 *
 * Unlike the sibling helper in visaSubmissionQueue.repo.test.ts (where both
 * waiters take mutually-compatible FOR SHARE locks and so both queue
 * directly behind the exclusive holder), this test's two waiters each
 * attempt a conflicting row-level UPDATE on the SAME tuple. Postgres's
 * per-tuple lock queue is FIFO for conflicting requests, so the second
 * waiter reports the FIRST waiter as its direct pg_blocking_pids() entry,
 * not blockerPid itself (confirmed empirically via a scratch diagnostic
 * polling pg_stat_activity: both backends sat "active"/Lock the entire
 * time, one waiting on blockerPid directly, the other waiting on the
 * first waiter's transaction id). This is documented, correct Postgres
 * queueing behavior, not a bug in the code under test -- so this helper
 * walks the chain instead of requiring every waiter to name blockerPid
 * directly.
 */
async function waitForBlockedCount(blockerPid: number, minCount: number, timeoutMs: number): Promise<Set<number>> {
  const deadline = Date.now() + timeoutMs;
  let lastSeen = new Set<number>();
  while (Date.now() < deadline) {
    const { rows } = await pool.query<{ pid: number; blockers: number[] }>(
      `SELECT pid, pg_blocking_pids(pid) AS blockers
       FROM pg_stat_activity
       WHERE pid <> $1 AND cardinality(pg_blocking_pids(pid)) > 0`,
      [blockerPid],
    );
    const blockersByPid = new Map(rows.map((row) => [row.pid, row.blockers]));
    const isRootedAtBlocker = (pid: number, seen: Set<number> = new Set()): boolean => {
      if (seen.has(pid)) {
        return false;
      }
      seen.add(pid);
      const blockers = blockersByPid.get(pid) ?? [];
      if (blockers.includes(blockerPid)) {
        return true;
      }
      return blockers.some((candidate) => isRootedAtBlocker(candidate, seen));
    };
    lastSeen = new Set(rows.map((row) => row.pid).filter((pid) => isRootedAtBlocker(pid)));
    if (lastSeen.size >= minCount) {
      return lastSeen;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return lastSeen;
}

function buildDeps(automation: VisaApplicantAutomationAdapter, checkPreflight = alwaysReadyPreflight): VisaWorkerLoopDependencies {
  return {
    queueStore: buildPostgresVisaSubmissionQueueStore(),
    lockStore: buildPostgresVisaBatchLockStore(),
    automation,
    checkPreflight,
    findActiveApplicantPositions: findActiveApplicantPositionsForBatch,
  };
}

// ============================================================================
// PURE UNIT TESTS -- the mock automation adapter's own behavior, no DB,
// no pool, no network. Clearly separated from the DB-integration tests
// below.
// ============================================================================

test('[unit] buildMockVisaApplicantAutomationAdapter: records every call and resolves exactly the pre-configured result, never a random one', async () => {
  const draft = buildFakeDraft('unit-test-identity');
  const mock = buildMockVisaApplicantAutomationAdapter({
    resultsByRecordId: { 'record-1': { outcome: 'SAVED' }, 'record-2': { outcome: 'ERROR', detail: 'portal rejected' } },
  });

  const resultA = await mock.submitApplicant({ recordId: 'record-1', draft, isLastApplicantInBatch: false, ...FAKE_PREFLIGHT_EXTRAS });
  const resultB = await mock.submitApplicant({ recordId: 'record-2', draft, isLastApplicantInBatch: true, ...FAKE_PREFLIGHT_EXTRAS });

  assert.deepEqual(resultA, { outcome: 'SAVED' });
  assert.deepEqual(resultB, { outcome: 'ERROR', detail: 'portal rejected' });
  assert.equal(mock.calls.length, 2);
  assert.equal(mock.calls[0]!.recordId, 'record-1');
  assert.equal(mock.calls[0]!.isLastApplicantInBatch, false);
  assert.equal(mock.calls[1]!.recordId, 'record-2');
  assert.equal(mock.calls[1]!.isLastApplicantInBatch, true);
});

test('[unit] buildMockVisaApplicantAutomationAdapter: an unconfigured recordId throws loudly, never falls back to a guessed outcome', async () => {
  const mock = buildMockVisaApplicantAutomationAdapter({ resultsByRecordId: {} });
  await assert.rejects(() => mock.submitApplicant({ recordId: 'never-configured', draft: buildFakeDraft('x'), isLastApplicantInBatch: true, ...FAKE_PREFLIGHT_EXTRAS }));
});

test('[unit] buildMockVisaApplicantAutomationAdapter: throwForRecordIds simulates a crash instead of resolving', async () => {
  const mock = buildMockVisaApplicantAutomationAdapter({
    resultsByRecordId: { 'record-1': { outcome: 'SAVED' } },
    throwForRecordIds: ['record-1'],
  });
  await assert.rejects(() => mock.submitApplicant({ recordId: 'record-1', draft: buildFakeDraft('x'), isLastApplicantInBatch: true, ...FAKE_PREFLIGHT_EXTRAS }));
  assert.equal(mock.calls.length, 1, 'the call is still recorded even though it threw');
});

// ============================================================================
// DB INTEGRATION TESTS -- real ocrumra_test PostgreSQL via
// buildPostgresVisaSubmissionQueueStore/buildPostgresVisaBatchLockStore,
// real claimApplicantForSubmission/finalizeApplicantSubmission/
// recoverStaleSubmittingToAmbiguous (visaSubmissionQueueOrchestrator.ts,
// unchanged). Only the automation adapter and the preflight check are
// faked -- both are pure, network-free, in-process functions (see the
// fixtures above and mockVisaApplicantAutomationAdapter.ts's own doc
// comment: no fetch/http/playwright import anywhere in that file).
// ============================================================================

test('[1] mock SAVED -> queue record becomes SAVED only after the mock reports it, never before', async () => {
  const groupId = await createGroup();
  try {
    const { recordId, batchId, passportIdentityId } = await createQueuedApplicant(groupId);
    const automation = buildMockVisaApplicantAutomationAdapter({ resultsByRecordId: { [recordId]: { outcome: 'SAVED' } } });

    const result = await runVisaWorkerLoopForBatch(
      batchId,
      'worker-1',
      [{ recordId, groupId, passportIdentityId }],
      Date.now(),
      buildDeps(automation),
    );

    assert.equal(result.lockOutcome, 'acquired');
    assert.deepEqual(result.applicantOutcomes, [{ recordId, outcome: 'SAVED' }]);
    assert.equal(automation.calls.length, 1, 'automation was called exactly once, for this exact record');

    const { rows } = await pool.query<{ status: string }>(`SELECT status FROM visa_submission_queue WHERE id = $1`, [recordId]);
    assert.equal(rows[0]!.status, 'SAVED');
  } finally {
    await cleanupAll([groupId]);
  }
});

test('[2] mock ERROR -> queue record becomes ERROR', async () => {
  const groupId = await createGroup();
  try {
    const { recordId, batchId, passportIdentityId } = await createQueuedApplicant(groupId);
    const automation = buildMockVisaApplicantAutomationAdapter({
      resultsByRecordId: { [recordId]: { outcome: 'ERROR', detail: 'portal showed a definite error page' } },
    });

    const result = await runVisaWorkerLoopForBatch(
      batchId,
      'worker-1',
      [{ recordId, groupId, passportIdentityId }],
      Date.now(),
      buildDeps(automation),
    );

    assert.deepEqual(result.applicantOutcomes, [
      { recordId, outcome: 'ERROR', detail: 'portal showed a definite error page' },
    ]);

    const { rows } = await pool.query<{ status: string }>(`SELECT status FROM visa_submission_queue WHERE id = $1`, [recordId]);
    assert.equal(rows[0]!.status, 'ERROR');
  } finally {
    await cleanupAll([groupId]);
  }
});

test('[3] mock AMBIGUOUS -> queue record becomes AMBIGUOUS', async () => {
  const groupId = await createGroup();
  try {
    const { recordId, batchId, passportIdentityId } = await createQueuedApplicant(groupId);
    const automation = buildMockVisaApplicantAutomationAdapter({
      resultsByRecordId: { [recordId]: { outcome: 'AMBIGUOUS', detail: 'timed out waiting for the save confirmation page' } },
    });

    const result = await runVisaWorkerLoopForBatch(
      batchId,
      'worker-1',
      [{ recordId, groupId, passportIdentityId }],
      Date.now(),
      buildDeps(automation),
    );

    assert.deepEqual(result.applicantOutcomes, [
      { recordId, outcome: 'AMBIGUOUS', detail: 'timed out waiting for the save confirmation page' },
    ]);

    const { rows } = await pool.query<{ status: string }>(`SELECT status FROM visa_submission_queue WHERE id = $1`, [recordId]);
    assert.equal(rows[0]!.status, 'AMBIGUOUS');
  } finally {
    await cleanupAll([groupId]);
  }
});

test('[4] preflight failure -> automation is never called, and the record is left claimed (SUBMITTING), never finalized blind', async () => {
  const groupId = await createGroup();
  try {
    const { recordId, batchId, passportIdentityId } = await createQueuedApplicant(groupId);
    // Deliberately configured with NO result for this recordId -- if
    // automation were ever (incorrectly) called, it would throw and fail
    // this test loudly rather than silently succeeding.
    const automation = buildMockVisaApplicantAutomationAdapter({ resultsByRecordId: {} });

    const result = await runVisaWorkerLoopForBatch(
      batchId,
      'worker-1',
      [{ recordId, groupId, passportIdentityId }],
      Date.now(),
      buildDeps(automation, alwaysNotReadyPreflight),
    );

    assert.equal(result.applicantOutcomes.length, 1);
    assert.equal(result.applicantOutcomes[0]!.outcome, 'SKIPPED_PREFLIGHT_FAILED');
    assert.equal(automation.calls.length, 0, 'automation must NEVER be invoked for an applicant preflight already rejected');

    const { rows } = await pool.query<{ status: string }>(`SELECT status FROM visa_submission_queue WHERE id = $1`, [recordId]);
    assert.equal(rows[0]!.status, 'SUBMITTING', 'claimed but never finalized -- preflight failure leaves it exactly where the claim put it');
  } finally {
    await cleanupAll([groupId]);
  }
});

test('[5] two parallel workers for the SAME batch and the SAME applicant -- AT MOST ONE successful claim/SAVED ever happens, never both', async () => {
  // Two valid interleavings exist here, and BOTH are safe -- this test
  // asserts the actual required invariant (at most one successful
  // claim/SAVED for the applicant, never a double-processed or corrupted
  // row), not which interleaving happens to occur:
  //   (a) the two runs genuinely overlap in time -> the SECOND worker's
  //       own acquireBatchProcessingLock call sees the lock already held
  //       and returns 'already-locked', touching no applicant at all; or
  //   (b) worker A's entire (mocked, near-instant) pipeline -- acquire,
  //       claim, preflight, automation, finalize, AND release -- finishes
  //       before worker B's own acquire call is even dispatched -> B then
  //       legitimately acquires the now-FREE lock too, but its OWN claim
  //       attempt on the already-SAVED applicant is then correctly
  //       rejected (CURRENT_STATUS_MISMATCH) by the same atomic
  //       claimApplicantForSubmission check proven in Package 4.6's own
  //       dedicated Promise.all claim test -- so the lock still did its
  //       job (no two sessions ever touched the applicant AT THE SAME
  //       TIME), it is just that there was no actual overlap to prevent.
  // A real (non-mocked, multi-second) automation step would make (a) the
  // overwhelmingly normal case; (b) is a real possibility only because
  // the mock resolves near-instantly -- confirmed empirically by directly
  // instrumenting this exact call path.
  const groupId = await createGroup();
  try {
    const { recordId, batchId, passportIdentityId } = await createQueuedApplicant(groupId);
    const automationA = buildMockVisaApplicantAutomationAdapter({ resultsByRecordId: { [recordId]: { outcome: 'SAVED' } } });
    const automationB = buildMockVisaApplicantAutomationAdapter({ resultsByRecordId: { [recordId]: { outcome: 'SAVED' } } });

    const [resultA, resultB] = await Promise.all([
      runVisaWorkerLoopForBatch(batchId, 'worker-a', [{ recordId, groupId, passportIdentityId }], Date.now(), buildDeps(automationA)),
      runVisaWorkerLoopForBatch(batchId, 'worker-b', [{ recordId, groupId, passportIdentityId }], Date.now(), buildDeps(automationB)),
    ]);

    const allOutcomes = [...resultA.applicantOutcomes, ...resultB.applicantOutcomes];
    const savedOutcomes = allOutcomes.filter((o) => o.outcome === 'SAVED');
    assert.equal(savedOutcomes.length, 1, 'exactly one SAVED across both workers combined -- never zero, never two');

    const rejectedOutcomes = allOutcomes.filter((o) => o.outcome === 'SKIPPED_NOT_CLAIMABLE');
    // Whichever worker did NOT produce the SAVED outcome either never
    // touched the applicant at all (lock-level rejection, applicantOutcomes
    // empty) or reached it and had its own claim correctly rejected
    // (claim-level rejection) -- either way, total outcomes recorded never
    // exceed exactly one per worker, and never both end in SAVED.
    assert.equal(savedOutcomes.length + rejectedOutcomes.length, allOutcomes.length, 'every recorded outcome is either the one SAVED or a correctly-rejected claim -- nothing else');

    const automationSuccessCalls = [...automationA.calls, ...automationB.calls];
    assert.equal(automationSuccessCalls.length, 1, 'automation (the step that would actually talk to a real portal) is invoked exactly once in total for this one applicant, never twice');

    const { rows } = await pool.query<{ status: string; count: string }>(
      `SELECT status, count(*)::text AS count FROM visa_submission_queue WHERE id = $1 GROUP BY status`,
      [recordId],
    );
    assert.equal(rows.length, 1, 'still exactly one queue row -- concurrency never created or duplicated one');
    assert.equal(rows[0]!.status, 'SAVED');
    assert.equal(rows[0]!.count, '1');
  } finally {
    await cleanupAll([groupId]);
  }
});

test('[6] running the worker loop again for an already-SAVED applicant never resubmits it -- automation is not called a second time', async () => {
  const groupId = await createGroup();
  try {
    const { recordId, batchId, passportIdentityId } = await createQueuedApplicant(groupId);
    const firstAutomation = buildMockVisaApplicantAutomationAdapter({ resultsByRecordId: { [recordId]: { outcome: 'SAVED' } } });
    const firstRun = await runVisaWorkerLoopForBatch(
      batchId,
      'worker-1',
      [{ recordId, groupId, passportIdentityId }],
      Date.now(),
      buildDeps(firstAutomation),
    );
    assert.deepEqual(firstRun.applicantOutcomes, [{ recordId, outcome: 'SAVED' }]);

    // A second, later run (e.g. the operator re-triggers /visa_queue_batch's
    // eventual worker equivalent, or the worker process restarts and
    // re-polls the same batch) -- deliberately configured with NO result
    // for this recordId, so if automation were ever called again it would
    // throw and fail this test loudly.
    const secondAutomation = buildMockVisaApplicantAutomationAdapter({ resultsByRecordId: {} });
    const secondRun = await runVisaWorkerLoopForBatch(
      batchId,
      'worker-2',
      [{ recordId, groupId, passportIdentityId }],
      Date.now(),
      buildDeps(secondAutomation),
    );

    assert.equal(secondRun.applicantOutcomes.length, 1);
    assert.equal(secondRun.applicantOutcomes[0]!.outcome, 'SKIPPED_NOT_CLAIMABLE');
    assert.equal(secondAutomation.calls.length, 0, 'an already-SAVED applicant must never be resubmitted');

    const { rows } = await pool.query<{ status: string }>(`SELECT status FROM visa_submission_queue WHERE id = $1`, [recordId]);
    assert.equal(rows[0]!.status, 'SAVED', 'still SAVED -- the second run never changed it');
  } finally {
    await cleanupAll([groupId]);
  }
});

test('[7a] automation crash (simulated worker interruption) -> UNEXPECTED_ERROR, record stays SUBMITTING, never guessed SAVED, never auto-reset to PENDING', async () => {
  const groupId = await createGroup();
  try {
    const { recordId, batchId, passportIdentityId } = await createQueuedApplicant(groupId);
    const automation = buildMockVisaApplicantAutomationAdapter({
      resultsByRecordId: { [recordId]: { outcome: 'SAVED' } },
      throwForRecordIds: [recordId],
    });

    const result = await runVisaWorkerLoopForBatch(
      batchId,
      'worker-1',
      [{ recordId, groupId, passportIdentityId }],
      Date.now(),
      buildDeps(automation),
    );

    assert.equal(result.applicantOutcomes.length, 1);
    assert.equal(result.applicantOutcomes[0]!.outcome, 'UNEXPECTED_ERROR');

    const { rows } = await pool.query<{ status: string }>(`SELECT status FROM visa_submission_queue WHERE id = $1`, [recordId]);
    assert.equal(rows[0]!.status, 'SUBMITTING', 'never SAVED despite the configured (but never returned, due to the throw) SAVED result, and never reset to PENDING');

    // A follow-up run must not blindly resubmit either -- it is still
    // SUBMITTING, so the claim itself is rejected before automation would
    // ever be reached again.
    const retryAutomation = buildMockVisaApplicantAutomationAdapter({ resultsByRecordId: {} });
    const retryResult = await runVisaWorkerLoopForBatch(
      batchId,
      'worker-2',
      [{ recordId, groupId, passportIdentityId }],
      Date.now(),
      buildDeps(retryAutomation),
    );
    assert.equal(retryResult.applicantOutcomes[0]!.outcome, 'SKIPPED_NOT_CLAIMABLE');
    assert.equal(retryAutomation.calls.length, 0, 'no automatic resubmission after a crash');
  } finally {
    await cleanupAll([groupId]);
  }
});

test('[7b] finalize rejection (status changed by another process while automation was running) -> UNEXPECTED_ERROR, the actual DB status is never overwritten to SAVED', async () => {
  const groupId = await createGroup();
  try {
    const { recordId, batchId, passportIdentityId } = await createQueuedApplicant(groupId);

    // A one-off automation adapter whose submitApplicant simulates "another
    // process concurrently finalized this exact record to ERROR while this
    // worker's own automation step was still in flight" -- a fully real,
    // realistic DB side effect via the SAME finalizeSubmission repo
    // function the orchestrator itself is built on, not a guessed hook.
    const concurrentFinalizeAutomation: VisaApplicantAutomationAdapter = {
      async submitApplicant() {
        const concurrent = await finalizeSubmission(recordId, 'ERROR', 'finalized by a different, concurrent process');
        assert.ok(concurrent, 'the simulated concurrent finalize must itself succeed (record was SUBMITTING at that point)');
        // This automation adapter itself still (wrongly, from its own
        // narrow point of view) believes the save succeeded.
        return { outcome: 'SAVED' };
      },
    };

    const result = await runVisaWorkerLoopForBatch(
      batchId,
      'worker-1',
      [{ recordId, groupId, passportIdentityId }],
      Date.now(),
      buildDeps(concurrentFinalizeAutomation),
    );

    assert.equal(result.applicantOutcomes.length, 1);
    assert.equal(result.applicantOutcomes[0]!.outcome, 'UNEXPECTED_ERROR');
    assert.match(result.applicantOutcomes[0]!.detail ?? '', /finalize rejected/);

    const { rows } = await pool.query<{ status: string; last_error: string | null }>(
      `SELECT status, last_error FROM visa_submission_queue WHERE id = $1`,
      [recordId],
    );
    assert.equal(rows[0]!.status, 'ERROR', "the record keeps whatever the OTHER process actually set -- never silently overwritten to this worker's own (wrong) SAVED belief");
  } finally {
    await cleanupAll([groupId]);
  }
});

test('[8] the batch lock is released even when an applicant throws unexpectedly -- a later worker can still proceed', async () => {
  const groupId = await createGroup();
  try {
    const { recordId, batchId, passportIdentityId } = await createQueuedApplicant(groupId);
    const crashingAutomation = buildMockVisaApplicantAutomationAdapter({
      resultsByRecordId: {},
      throwForRecordIds: [recordId],
    });

    const firstRun = await runVisaWorkerLoopForBatch(
      batchId,
      'worker-1',
      [{ recordId, groupId, passportIdentityId }],
      Date.now(),
      buildDeps(crashingAutomation),
    );
    assert.equal(firstRun.lockOutcome, 'acquired');
    assert.equal(firstRun.applicantOutcomes[0]!.outcome, 'UNEXPECTED_ERROR');

    // Lock must be free again -- a second worker (e.g. a restarted
    // process) can immediately acquire it, even though the first run's
    // one applicant ended in an unexpected error.
    const { rows: lockRows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM visa_batch_processing_locks WHERE batch_id = $1`,
      [batchId],
    );
    assert.equal(lockRows[0]!.count, '0', 'the lock row must be gone -- released in the finally block despite the applicant-level crash');

    const secondAutomation = buildMockVisaApplicantAutomationAdapter({ resultsByRecordId: {} });
    const secondRun = await runVisaWorkerLoopForBatch(batchId, 'worker-2', [], Date.now(), buildDeps(secondAutomation));
    assert.equal(secondRun.lockOutcome, 'acquired', 'a later worker must be able to acquire the lock -- it was not left stuck held');
  } finally {
    await cleanupAll([groupId]);
  }
});

test('[9] running the full worker loop with the mock automation adapter never triggers a real network fetch', async () => {
  const groupId = await createGroup();
  try {
    const { recordId, batchId, passportIdentityId } = await createQueuedApplicant(groupId);
    const automation = buildMockVisaApplicantAutomationAdapter({ resultsByRecordId: { [recordId]: { outcome: 'SAVED' } } });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('unexpected real network fetch call during a mock-only worker loop run');
    }) as typeof fetch;

    try {
      const result = await runVisaWorkerLoopForBatch(
        batchId,
        'worker-1',
        [{ recordId, groupId, passportIdentityId }],
        Date.now(),
        buildDeps(automation),
      );
      assert.deepEqual(result.applicantOutcomes, [{ recordId, outcome: 'SAVED' }]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    await cleanupAll([groupId]);
  }
});

test('[10] a stale SUBMITTING record is recovered to AMBIGUOUS by the EXISTING recoverStaleSubmittingToAmbiguous mechanism (real Postgres store), never back to PENDING', async () => {
  const groupId = await createGroup();
  try {
    const { recordId, batchId } = await createQueuedApplicant(groupId);
    const queueStore = buildPostgresVisaSubmissionQueueStore();

    // Claim it (PENDING -> SUBMITTING), simulating a worker that then
    // crashed before ever observing an automation outcome -- never call
    // finalize at all.
    const claim = await claimApplicantForSubmission(queueStore, recordId, Date.now());
    assert.ok(claim.ok);

    // Backdate claimed_at directly -- a plain column, not trigger-maintained
    // (only updated_at carries the set_updated_at trigger on this table;
    // see migrations/0028's own schema), so no trigger-bypass technique is
    // needed here at all.
    await pool.query(`UPDATE visa_submission_queue SET claimed_at = now() - interval '1 hour' WHERE id = $1`, [recordId]);

    const recovery = await recoverStaleSubmittingToAmbiguous(queueStore, Date.now(), 10 * 60_000);
    assert.equal(recovery.movedToAmbiguous.length, 1);
    assert.equal(recovery.movedToAmbiguous[0]!.id, recordId);

    const { rows } = await pool.query<{ status: string }>(`SELECT status FROM visa_submission_queue WHERE id = $1`, [recordId]);
    assert.equal(rows[0]!.status, 'AMBIGUOUS', 'moved to AMBIGUOUS, never back to PENDING');
    void batchId;
  } finally {
    await cleanupAll([groupId]);
  }
});

test('[11] running recoverStaleSubmittingToAmbiguous AGAIN (real Postgres store) never re-touches an already-AMBIGUOUS record, and never disturbs an unrelated SAVED record', async () => {
  // The in-memory-fake-backed orchestrator test ("SAVED, ERROR, and
  // AMBIGUOUS records are never picked up by the stale-SUBMITTING sweep",
  // tests/visa.visaSubmissionQueueOrchestrator.test.ts) already proves this
  // at the pure orchestration-logic level. This is the REAL-database
  // counterpart: findStaleSubmitting's own SQL (`WHERE status = 'SUBMITTING'
  // AND claimed_at < ...`) structurally excludes every terminal status both
  // by status AND because finalizeSubmission always clears claimed_at to
  // NULL on any SUBMITTING -> {SAVED|ERROR|AMBIGUOUS} transition -- this
  // test exercises that real SQL, not a fake, and covers running the sweep
  // TWICE in a row (idempotent recovery).
  const groupA = await createGroup();
  const groupB = await createGroup();
  try {
    const stale = await createQueuedApplicant(groupA);
    const queueStore = buildPostgresVisaSubmissionQueueStore();

    const claim = await claimApplicantForSubmission(queueStore, stale.recordId, Date.now());
    assert.ok(claim.ok);
    await pool.query(`UPDATE visa_submission_queue SET claimed_at = now() - interval '1 hour' WHERE id = $1`, [stale.recordId]);

    const firstRecovery = await recoverStaleSubmittingToAmbiguous(queueStore, Date.now(), 10 * 60_000);
    assert.equal(firstRecovery.movedToAmbiguous.length, 1);
    assert.equal(firstRecovery.movedToAmbiguous[0]!.id, stale.recordId);

    // A genuinely SAVED applicant, in a DIFFERENT group/batch, finalized
    // normally (no backdating involved at all) -- finalizeSubmission's own
    // SQL already sets claimed_at = NULL on this transition.
    const saved = await createQueuedApplicant(groupB);
    const savedClaim = await claimApplicantForSubmission(queueStore, saved.recordId, Date.now());
    assert.ok(savedClaim.ok);
    const finalizeResult = await finalizeSubmission(saved.recordId, 'SAVED');
    assert.ok(finalizeResult);

    // Run the sweep again -- must find NOTHING: the first record is now
    // AMBIGUOUS (not SUBMITTING), and the second is SAVED. Neither is ever
    // re-touched or reverted.
    const secondRecovery = await recoverStaleSubmittingToAmbiguous(queueStore, Date.now(), 10 * 60_000);
    assert.equal(secondRecovery.movedToAmbiguous.length, 0, 'nothing left to recover -- the sweep is idempotent');
    assert.equal(secondRecovery.lostRaceAgainstFinish.length, 0);
    assert.equal(secondRecovery.unexpectedFailures.length, 0);

    const { rows } = await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM visa_submission_queue WHERE id IN ($1, $2)`,
      [stale.recordId, saved.recordId],
    );
    const statusById = new Map(rows.map((r) => [r.id, r.status]));
    assert.equal(statusById.get(stale.recordId), 'AMBIGUOUS', 'still AMBIGUOUS -- the second sweep never reverted or re-processed it');
    assert.equal(statusById.get(saved.recordId), 'SAVED', 'the unrelated SAVED record was never touched by either sweep');
  } finally {
    await cleanupAll([groupA, groupB]);
  }
});

test('[21] recoverStaleSubmittingToAmbiguous (real Postgres store) never touches a SUBMITTING record that is still fresh, even while a stale one alongside it IS recovered', async () => {
  // Package 5.8: closes the one real-DB gap Package 5.7's audit correctly
  // flagged -- tests [10]/[11] above already use the real Postgres store,
  // but neither one has a FRESH (non-stale) SUBMITTING record coexisting
  // in the SAME sweep call. The in-memory-fake orchestrator test
  // ("does NOT touch a SUBMITTING record that is still fresh",
  // tests/visa.visaSubmissionQueueOrchestrator.test.ts) already proves this
  // at the pure orchestration-logic level; this is the real-SQL counterpart.
  const groupA = await createGroup();
  const groupB = await createGroup();
  try {
    const stale = await createQueuedApplicant(groupA);
    const fresh = await createQueuedApplicant(groupB);
    const queueStore = buildPostgresVisaSubmissionQueueStore();

    const staleClaim = await claimApplicantForSubmission(queueStore, stale.recordId, Date.now());
    assert.ok(staleClaim.ok);
    await pool.query(`UPDATE visa_submission_queue SET claimed_at = now() - interval '1 hour' WHERE id = $1`, [stale.recordId]);

    const freshClaim = await claimApplicantForSubmission(queueStore, fresh.recordId, Date.now());
    assert.ok(freshClaim.ok);
    // fresh.recordId's claimed_at is left exactly as claimApplicantForSubmission
    // just set it (now()) -- never backdated.

    const recovery = await recoverStaleSubmittingToAmbiguous(queueStore, Date.now(), 10 * 60_000);
    assert.equal(recovery.movedToAmbiguous.length, 1, 'only the genuinely stale record must be picked up');
    assert.equal(recovery.movedToAmbiguous[0]!.id, stale.recordId);

    const { rows } = await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM visa_submission_queue WHERE id IN ($1, $2)`,
      [stale.recordId, fresh.recordId],
    );
    const statusById = new Map(rows.map((r) => [r.id, r.status]));
    assert.equal(statusById.get(stale.recordId), 'AMBIGUOUS');
    assert.equal(statusById.get(fresh.recordId), 'SUBMITTING', 'the fresh record must be left exactly as it was -- never touched');
  } finally {
    await cleanupAll([groupA, groupB]);
  }
});

test('[22] recoverStaleSubmittingToAmbiguous racing a REAL, concurrent finalize on the SAME stale record -- exactly one wins, the loser is reported cleanly, never both and never an unexpected failure', async () => {
  // Package 5.8: the second real-DB gap Package 5.7's audit flagged -- [10]/
  // [11] only ever call claim/finalize SEQUENTIALLY (fully awaited before
  // the next step), so recoverStaleSubmittingToAmbiguous's own
  // lostRaceAgainstFinish branch (orchestrator.ts's per-record
  // requestTransition failing because the record "legitimately finished in
  // the gap between the two calls") has never been exercised against a
  // GENUINE, concurrent PostgreSQL race. A third connection (clientC) holds
  // an explicit FOR UPDATE lock on the queue row open indefinitely, forcing
  // both the recovery sweep's own UPDATE and a concurrent finalizeSubmission
  // UPDATE to queue up behind it, deterministically (not a narrow timing
  // window to miss) -- confirmed via pg_blocking_pids, the same documented
  // technique already used throughout this engagement's other real-connection
  // tests.
  const groupId = await createGroup();
  const clientC = await pool.connect();
  let clientCInTransaction = false;
  let recoveryPromise: ReturnType<typeof recoverStaleSubmittingToAmbiguous> | undefined;
  let finalizePromise: ReturnType<typeof finalizeSubmission> | undefined;
  try {
    const { recordId } = await createQueuedApplicant(groupId);
    const queueStore = buildPostgresVisaSubmissionQueueStore();
    const claim = await claimApplicantForSubmission(queueStore, recordId, Date.now());
    assert.ok(claim.ok);
    await pool.query(`UPDATE visa_submission_queue SET claimed_at = now() - interval '1 hour' WHERE id = $1`, [recordId]);

    await clientC.query('BEGIN');
    clientCInTransaction = true;
    await clientC.query('SELECT id FROM visa_submission_queue WHERE id = $1 FOR UPDATE', [recordId]);

    const {
      rows: [backend],
    } = await clientC.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    assert.ok(backend);
    const clientCPid = backend.pid;

    recoveryPromise = recoverStaleSubmittingToAmbiguous(queueStore, Date.now(), 10 * 60_000);
    finalizePromise = finalizeSubmission(recordId, 'SAVED');

    const blockedPids = await waitForBlockedCount(clientCPid, 2, 5000);
    assert.equal(
      blockedPids.size,
      2,
      `expected BOTH the recovery sweep's own transition attempt and the concurrent finalize to be genuinely blocked behind clientC's ` +
        `held lock -- observed ${blockedPids.size}; without this confirmation the test cannot be trusted as a real concurrency proof`,
    );

    await clientC.query('COMMIT');
    clientCInTransaction = false;

    const [recoveryResult, finalizeResult] = await Promise.all([recoveryPromise, finalizePromise]);
    recoveryPromise = undefined;
    finalizePromise = undefined;

    assert.equal(recoveryResult.unexpectedFailures.length, 0, 'a lost race must never be reported as an unexpected failure');

    const { rows } = await pool.query<{ status: string }>('SELECT status FROM visa_submission_queue WHERE id = $1', [recordId]);
    const finalStatus = rows[0]!.status;
    assert.ok(
      finalStatus === 'AMBIGUOUS' || finalStatus === 'SAVED',
      `expected exactly one winner (AMBIGUOUS or SAVED), got ${finalStatus}`,
    );

    if (finalStatus === 'AMBIGUOUS') {
      assert.equal(recoveryResult.movedToAmbiguous.length, 1, 'recovery won the race');
      assert.equal(recoveryResult.lostRaceAgainstFinish.length, 0);
      assert.equal(finalizeResult, null, "finalize must have lost -- its own WHERE status='SUBMITTING' no longer matched");
    } else {
      assert.equal(recoveryResult.movedToAmbiguous.length, 0, 'recovery must have lost the race');
      assert.equal(recoveryResult.lostRaceAgainstFinish.length, 1, 'recovery must report this record as a lost race, never an error');
      assert.equal(recoveryResult.lostRaceAgainstFinish[0], recordId);
      assert.ok(finalizeResult, 'finalize won the race');
      assert.equal(finalizeResult.status, 'SAVED');
    }
  } finally {
    if (clientCInTransaction) {
      await clientC.query('ROLLBACK').catch(() => {});
    }
    if (recoveryPromise) {
      await recoveryPromise.catch(() => {});
    }
    if (finalizePromise) {
      await finalizePromise.catch(() => {});
    }
    clientC.release();
    await cleanupAll([groupId]);
  }
});

test('Package 5.24: one record genuinely failing against the REAL Postgres store never blocks a sibling record\'s real AMBIGUOUS transition in the same sweep', async () => {
  // Closes the Package 5.21/5.23 coverage gap: the per-record isolation
  // behavior (visaSubmissionQueueOrchestrator.ts's own try/catch around
  // requestTransition inside recoverStaleSubmittingToAmbiguous) was only
  // ever proven against the in-memory fake
  // (visa.visaSubmissionQueueOrchestrator.test.ts: "one record failing
  // unexpectedly during the stale-recovery sweep never blocks the others").
  // This is the real-Postgres counterpart: a thin wrapper around the REAL
  // store (buildPostgresVisaSubmissionQueueStore) delegates genuinely to
  // Postgres for every call except ONE targeted record's atomicTransition,
  // which is made to throw -- no DB privilege/session manipulation, no
  // schema change, same wrapping technique already used for the fake.
  const groupGood = await createGroup();
  const groupBad = await createGroup();
  try {
    const good = await createQueuedApplicant(groupGood);
    const bad = await createQueuedApplicant(groupBad);
    const realStore = buildPostgresVisaSubmissionQueueStore();

    const goodClaim = await claimApplicantForSubmission(realStore, good.recordId, Date.now());
    assert.ok(goodClaim.ok);
    const badClaim = await claimApplicantForSubmission(realStore, bad.recordId, Date.now());
    assert.ok(badClaim.ok);
    await pool.query(`UPDATE visa_submission_queue SET claimed_at = now() - interval '1 hour' WHERE id IN ($1, $2)`, [
      good.recordId,
      bad.recordId,
    ]);

    const originalAtomicTransition = realStore.atomicTransition.bind(realStore);
    realStore.atomicTransition = async (recordId, from, to, nowMs) => {
      if (recordId === bad.recordId) {
        throw new Error('Package 5.24: simulated per-record failure against the REAL store');
      }
      return originalAtomicTransition(recordId, from, to, nowMs);
    };

    const recovery = await recoverStaleSubmittingToAmbiguous(realStore, Date.now(), 10 * 60_000);
    assert.equal(recovery.movedToAmbiguous.length, 1, 'the good record must still be recovered despite the sibling failure');
    assert.equal(recovery.movedToAmbiguous[0]!.id, good.recordId);
    assert.equal(recovery.unexpectedFailures.length, 1);
    assert.equal(recovery.unexpectedFailures[0]!.recordId, bad.recordId);

    const { rows } = await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM visa_submission_queue WHERE id IN ($1, $2)`,
      [good.recordId, bad.recordId],
    );
    const statusById = new Map(rows.map((r) => [r.id, r.status]));
    assert.equal(statusById.get(good.recordId), 'AMBIGUOUS', 'the good record\'s AMBIGUOUS transition must be a REAL, committed Postgres write');
    assert.equal(statusById.get(bad.recordId), 'SUBMITTING', 'the failed record must be left exactly as it was -- never touched');
  } finally {
    await cleanupAll([groupGood, groupBad]);
  }
});

test('[12] isLastApplicantInBatch is true ONLY for the last applicant in the given list -- the real SAVE vs SAVE AND MOVE TO THE NEXT APPLICANT signal', async () => {
  // VisaApplicantAutomationAdapter's own doc comment: every applicant
  // except the batch's last one must be submitted via SAVE AND MOVE TO
  // THE NEXT APPLICANT; only the last uses plain SAVE. The worker loop
  // (visaWorkerLoop.ts) computes this itself, purely from the given
  // applicants list's own order -- never re-derived from batch size or
  // guessed by the automation adapter.
  const groupId = await createGroup();
  try {
    const identityIds = [await createIdentity(), await createIdentity(), await createIdentity()];
    const assignments = [];
    for (const identityId of identityIds) {
      assignments.push(await assignVisaBatch(groupId, identityId, 'visitsaudi', '2026-12-01'));
    }
    const batchId = assignments[0]!.batchId;
    assert.ok(assignments.every((a) => a.batchId === batchId), 'all three applicants landed in the same batch');

    const attempt = await createSubmissionAttempt(batchId, 'operator:test');
    const created = await createQueueForBatch(batchId, attempt.id);
    assert.ok(created && created.length === 3);

    const applicantsInput = assignments.map((assignment, i) => {
      const record = created.find((r) => r.visaBatchApplicantId === assignment.id);
      assert.ok(record);
      return { recordId: record.id, groupId, passportIdentityId: identityIds[i]! };
    });

    const automation = buildMockVisaApplicantAutomationAdapter({
      resultsByRecordId: Object.fromEntries(applicantsInput.map((a) => [a.recordId, { outcome: 'SAVED' as const }])),
    });

    const result = await runVisaWorkerLoopForBatch(batchId, 'worker-1', applicantsInput, Date.now(), buildDeps(automation));

    assert.equal(result.applicantOutcomes.length, 3);
    assert.ok(result.applicantOutcomes.every((o) => o.outcome === 'SAVED'));
    assert.equal(automation.calls.length, 3);
    assert.equal(automation.calls[0]!.isLastApplicantInBatch, false, 'applicant 1 of 3 -- SAVE AND MOVE TO THE NEXT APPLICANT');
    assert.equal(automation.calls[1]!.isLastApplicantInBatch, false, 'applicant 2 of 3 -- SAVE AND MOVE TO THE NEXT APPLICANT');
    assert.equal(automation.calls[2]!.isLastApplicantInBatch, true, 'applicant 3 of 3 (the last) -- plain SAVE');
  } finally {
    await cleanupAll([groupId]);
  }
});

// ============================================================================
// PACKAGE 5.1 HARDENING -- Package 5.0 audit finding #1 (applicant/group
// identifiers never cross-checked) and finding #2 (isLastApplicantInBatch
// trusted from the given list's own index alone, never verified against
// the batch's real membership/order).
// ============================================================================

test('[13] groupId mismatch (recordId is real, but the given groupId is wrong) -> IDENTITY_MISMATCH, never claimed, automation never called', async () => {
  const groupA = await createGroup();
  const groupB = await createGroup();
  try {
    const applicant = await createQueuedApplicant(groupA);
    const automation = buildMockVisaApplicantAutomationAdapter({ resultsByRecordId: {} });

    const result = await runVisaWorkerLoopForBatch(
      applicant.batchId,
      'worker-1',
      [{ recordId: applicant.recordId, groupId: groupB, passportIdentityId: applicant.passportIdentityId }],
      Date.now(),
      buildDeps(automation),
    );

    assert.equal(result.batchValidation?.outcome, 'ok', 'the passportIdentityId itself is correct, so batch-level validation alone would not catch this -- the per-applicant identity check must');
    assert.equal(result.applicantOutcomes.length, 1);
    assert.equal(result.applicantOutcomes[0]!.outcome, 'IDENTITY_MISMATCH');
    assert.equal(automation.calls.length, 0, 'automation must never be called for a mismatched identity');

    const { rows } = await pool.query<{ status: string }>(`SELECT status FROM visa_submission_queue WHERE id = $1`, [applicant.recordId]);
    assert.equal(rows[0]!.status, 'PENDING', 'never claimed at all -- the identity check runs BEFORE claimForSubmission');
  } finally {
    await cleanupAll([groupA, groupB]);
  }
});

test('[14] passportIdentityId mismatch (belongs to a DIFFERENT real applicant actually in this same batch) -> IDENTITY_MISMATCH for the swapped entry, the other applicant unaffected, no cross-applicant SAVED', async () => {
  // Constructed so batch-level validation (test [2] of the two hardening
  // layers) PASSES -- the given list's passportIdentityId sequence
  // [identityA, identityB] matches the batch's real position_in_batch
  // order exactly -- so this specifically exercises the PER-APPLICANT
  // identity cross-check: each entry's recordId is swapped to point at
  // the OTHER applicant's real queue row.
  const groupId = await createGroup();
  try {
    const { batchId, applicants } = await createMultiApplicantBatch(groupId, 2);
    const [a, b] = applicants as [{ recordId: string; passportIdentityId: string }, { recordId: string; passportIdentityId: string }];

    const swappedInput = [
      { recordId: b.recordId, groupId, passportIdentityId: a.passportIdentityId }, // wrong: b's real record, claimed as a's identity
      { recordId: a.recordId, groupId, passportIdentityId: b.passportIdentityId }, // wrong: a's real record, claimed as b's identity
    ];

    const automation = buildMockVisaApplicantAutomationAdapter({ resultsByRecordId: {} });
    const result = await runVisaWorkerLoopForBatch(batchId, 'worker-1', swappedInput, Date.now(), buildDeps(automation));

    assert.equal(result.batchValidation?.outcome, 'ok', 'the given passportIdentityId sequence [a, b] still matches the real position order -- only the per-recordId pairing is wrong');
    assert.equal(result.applicantOutcomes.length, 2);
    assert.ok(result.applicantOutcomes.every((o) => o.outcome === 'IDENTITY_MISMATCH'), 'both swapped entries are individually caught');
    assert.equal(automation.calls.length, 0, 'automation must never be called for either mismatched identity');

    const { rows } = await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM visa_submission_queue WHERE id IN ($1, $2)`,
      [a.recordId, b.recordId],
    );
    assert.ok(rows.every((r) => r.status === 'PENDING'), 'neither real record was ever claimed, let alone finalized as SAVED for the wrong applicant');
  } finally {
    await cleanupAll([groupId]);
  }
});

test('[16] empty applicants list given for a batch that has an active applicant -> batch validation rejected, automation never called', async () => {
  const groupId = await createGroup();
  try {
    const applicant = await createQueuedApplicant(groupId);
    const automation = buildMockVisaApplicantAutomationAdapter({ resultsByRecordId: {} });

    const result = await runVisaWorkerLoopForBatch(applicant.batchId, 'worker-1', [], Date.now(), buildDeps(automation));

    assert.equal(result.batchValidation?.outcome, 'rejected');
    assert.match(result.batchValidation && result.batchValidation.outcome === 'rejected' ? result.batchValidation.reason : '', /0 entr.*1|has 1/);
    assert.deepEqual(result.applicantOutcomes, []);
    assert.equal(automation.calls.length, 0);

    const { rows } = await pool.query<{ status: string }>(`SELECT status FROM visa_submission_queue WHERE id = $1`, [applicant.recordId]);
    assert.equal(rows[0]!.status, 'PENDING', 'the real, un-listed applicant is never touched either');
  } finally {
    await cleanupAll([groupId]);
  }
});

test('[17] partial applicants list (batch really has 3, only 2 given) -> batch validation rejected, NONE of the 3 applicants is processed', async () => {
  const groupId = await createGroup();
  try {
    const { batchId, applicants } = await createMultiApplicantBatch(groupId, 3);
    const partialInput = applicants.slice(0, 2).map((a) => ({ recordId: a.recordId, groupId, passportIdentityId: a.passportIdentityId }));

    const automation = buildMockVisaApplicantAutomationAdapter({ resultsByRecordId: {} });
    const result = await runVisaWorkerLoopForBatch(batchId, 'worker-1', partialInput, Date.now(), buildDeps(automation));

    assert.equal(result.batchValidation?.outcome, 'rejected');
    assert.deepEqual(result.applicantOutcomes, [], 'not even the 2 CORRECTLY-given applicants are processed -- the whole batch run is refused');
    assert.equal(automation.calls.length, 0);

    const { rows } = await pool.query<{ status: string; count: string }>(
      `SELECT status, count(*)::text AS count FROM visa_submission_queue WHERE batch_id = $1 GROUP BY status`,
      [batchId],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.status, 'PENDING');
    assert.equal(rows[0]!.count, '3', 'all 3 real applicants, including the 2 that were given, stay untouched');
  } finally {
    await cleanupAll([groupId]);
  }
});

test('[18] duplicate passportIdentityId in the given list -> batch validation rejected before any real/position comparison', async () => {
  const groupId = await createGroup();
  try {
    const { batchId, applicants } = await createMultiApplicantBatch(groupId, 2);
    const [a] = applicants as [{ recordId: string; passportIdentityId: string }, { recordId: string; passportIdentityId: string }];
    const duplicatedInput = [
      { recordId: a.recordId, groupId, passportIdentityId: a.passportIdentityId },
      { recordId: a.recordId, groupId, passportIdentityId: a.passportIdentityId },
    ];

    const automation = buildMockVisaApplicantAutomationAdapter({ resultsByRecordId: {} });
    const result = await runVisaWorkerLoopForBatch(batchId, 'worker-1', duplicatedInput, Date.now(), buildDeps(automation));

    assert.equal(result.batchValidation?.outcome, 'rejected');
    assert.match(result.batchValidation!.outcome === 'rejected' ? result.batchValidation!.reason : '', /duplicate/);
    assert.deepEqual(result.applicantOutcomes, []);
    assert.equal(automation.calls.length, 0);
  } finally {
    await cleanupAll([groupId]);
  }
});

test('[19] given list in the WRONG order relative to the batch\'s real position_in_batch -> batch validation rejected, isLastApplicantInBatch never computed from an unverified order', async () => {
  const groupId = await createGroup();
  try {
    const { batchId, applicants } = await createMultiApplicantBatch(groupId, 2);
    const [a, b] = applicants as [{ recordId: string; passportIdentityId: string }, { recordId: string; passportIdentityId: string }];
    // Real order is [a, b] (creation/position order) -- given in the
    // REVERSE order, with correctly-paired recordId/passportIdentityId
    // per entry (so this exercises ONLY the order check, not the
    // per-applicant identity check from tests [13]/[14]).
    const reversedInput = [
      { recordId: b.recordId, groupId, passportIdentityId: b.passportIdentityId },
      { recordId: a.recordId, groupId, passportIdentityId: a.passportIdentityId },
    ];

    const automation = buildMockVisaApplicantAutomationAdapter({ resultsByRecordId: {} });
    const result = await runVisaWorkerLoopForBatch(batchId, 'worker-1', reversedInput, Date.now(), buildDeps(automation));

    assert.equal(result.batchValidation?.outcome, 'rejected');
    assert.match(result.batchValidation!.outcome === 'rejected' ? result.batchValidation!.reason : '', /order/);
    assert.deepEqual(result.applicantOutcomes, []);
    assert.equal(automation.calls.length, 0, 'automation is never reached, so the wrong applicant is never pressed SAVE as "last"');
  } finally {
    await cleanupAll([groupId]);
  }
});

test('[20] an applicant from a DIFFERENT batch mistakenly included -> batch validation rejected', async () => {
  const groupA = await createGroup();
  const groupB = await createGroup();
  try {
    const applicantInBatchA = await createQueuedApplicant(groupA);
    const applicantInBatchB = await createQueuedApplicant(groupB);

    const automation = buildMockVisaApplicantAutomationAdapter({ resultsByRecordId: {} });
    const result = await runVisaWorkerLoopForBatch(
      applicantInBatchA.batchId,
      'worker-1',
      // Correct groupId/passportIdentityId pairing for the wrong entry,
      // but this applicant genuinely belongs to a DIFFERENT batch than
      // the one this run is for.
      [{ recordId: applicantInBatchB.recordId, groupId: groupB, passportIdentityId: applicantInBatchB.passportIdentityId }],
      Date.now(),
      buildDeps(automation),
    );

    assert.equal(result.batchValidation?.outcome, 'rejected');
    assert.deepEqual(result.applicantOutcomes, []);
    assert.equal(automation.calls.length, 0);

    const { rows } = await pool.query<{ status: string }>(`SELECT status FROM visa_submission_queue WHERE id = $1`, [
      applicantInBatchA.recordId,
    ]);
    assert.equal(rows[0]!.status, 'PENDING', "batch A's own real applicant was never touched either -- the whole run was refused");
  } finally {
    await cleanupAll([groupA, groupB]);
  }
});
