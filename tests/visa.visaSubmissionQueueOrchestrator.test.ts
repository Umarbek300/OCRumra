import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildInMemoryVisaBatchLockStore,
  buildInMemoryVisaSubmissionQueueStore,
} from '../src/visa/visaSubmissionQueueStore.js';
import {
  acquireBatchProcessingLock,
  claimApplicantForSubmission,
  finalizeApplicantSubmission,
  recoverStaleBatchLocks,
  recoverStaleSubmittingToAmbiguous,
  releaseBatchProcessingLock,
  requestTransition,
} from '../src/visa/visaSubmissionQueueOrchestrator.js';

test('claimApplicantForSubmission succeeds exactly once for two "parallel" claim attempts on the SAME record', async () => {
  // See visaSubmissionQueueStore.ts's own DISCLOSED LIMITATION: this proves
  // the ORCHESTRATION LOGIC correctly surfaces "only one winner" given a
  // store that behaves atomically -- it does NOT, and cannot, prove real
  // PostgreSQL-level cross-process atomicity.
  const store = buildInMemoryVisaSubmissionQueueStore();
  const record = await store.createRecord({ groupId: 'g', batchId: 'b', passportIdentityId: 'i' });

  const [resultA, resultB] = await Promise.all([
    claimApplicantForSubmission(store, record.id, 1000),
    claimApplicantForSubmission(store, record.id, 1000),
  ]);

  const outcomes = [resultA.ok, resultB.ok];
  assert.deepEqual(outcomes.filter(Boolean).length, 1); // exactly one winner
  const loser = resultA.ok ? resultB : resultA;
  assert.equal(loser.ok, false);
  if (loser.ok) throw new Error('unreachable');
  assert.equal(loser.reason, 'CURRENT_STATUS_MISMATCH');
});

test('re-claiming an already-SUBMITTING record is rejected, never silently re-granted', async () => {
  const store = buildInMemoryVisaSubmissionQueueStore();
  const record = await store.createRecord({ groupId: 'g', batchId: 'b', passportIdentityId: 'i' });
  await claimApplicantForSubmission(store, record.id, 1000);

  const secondAttempt = await claimApplicantForSubmission(store, record.id, 2000);

  assert.equal(secondAttempt.ok, false);
  if (secondAttempt.ok) throw new Error('unreachable');
  assert.equal(secondAttempt.reason, 'CURRENT_STATUS_MISMATCH');
});

test('finalizeApplicantSubmission moves a claimed record to SAVED', async () => {
  const store = buildInMemoryVisaSubmissionQueueStore();
  const record = await store.createRecord({ groupId: 'g', batchId: 'b', passportIdentityId: 'i' });
  await claimApplicantForSubmission(store, record.id, 1000);

  const result = await finalizeApplicantSubmission(store, record.id, 'SAVED', 2000);

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('unreachable');
  assert.equal(result.record.status, 'SAVED');
});

for (const outcome of ['SAVED', 'ERROR', 'AMBIGUOUS'] as const) {
  test(`a finalized ${outcome} record can never be re-claimed`, async () => {
    const store = buildInMemoryVisaSubmissionQueueStore();
    const record = await store.createRecord({ groupId: 'g', batchId: 'b', passportIdentityId: 'i' });
    await claimApplicantForSubmission(store, record.id, 1000);
    await finalizeApplicantSubmission(store, record.id, outcome, 2000);

    const reclaim = await claimApplicantForSubmission(store, record.id, 3000);

    assert.equal(reclaim.ok, false);
  });
}

test('finalizing a record that was never claimed (still PENDING) is rejected -- SUBMITTING is required first', async () => {
  const store = buildInMemoryVisaSubmissionQueueStore();
  const record = await store.createRecord({ groupId: 'g', batchId: 'b', passportIdentityId: 'i' });

  const result = await finalizeApplicantSubmission(store, record.id, 'SAVED', 1000);

  assert.equal(result.ok, false);
  if (result.ok) throw new Error('unreachable');
  assert.equal(result.reason, 'CURRENT_STATUS_MISMATCH');
});

test('requestTransition rejects a forbidden transition BEFORE ever touching the store', async () => {
  let atomicTransitionCalled = false;
  const store = buildInMemoryVisaSubmissionQueueStore();
  const record = await store.createRecord({ groupId: 'g', batchId: 'b', passportIdentityId: 'i' });
  const originalAtomicTransition = store.atomicTransition.bind(store);
  store.atomicTransition = async (...args) => {
    atomicTransitionCalled = true;
    return originalAtomicTransition(...args);
  };

  const result = await requestTransition(store, record.id, 'PENDING', 'SAVED', 1000); // PENDING -> SAVED is forbidden

  assert.deepEqual(result, { ok: false, reason: 'FORBIDDEN_TRANSITION' });
  assert.equal(atomicTransitionCalled, false);
});

test('recoverStaleSubmittingToAmbiguous moves a stale SUBMITTING record to AMBIGUOUS, never back to PENDING', async () => {
  const store = buildInMemoryVisaSubmissionQueueStore();
  const record = await store.createRecord({ groupId: 'g', batchId: 'b', passportIdentityId: 'i' });
  await claimApplicantForSubmission(store, record.id, 0); // claimed at t=0

  const result = await recoverStaleSubmittingToAmbiguous(store, 10_000, 10_000); // now=10000, threshold=10000

  assert.equal(result.movedToAmbiguous.length, 1);
  assert.equal(result.movedToAmbiguous[0]!.status, 'AMBIGUOUS');
  const stored = await store.getRecord(record.id);
  assert.equal(stored?.status, 'AMBIGUOUS'); // never PENDING
});

test('recoverStaleSubmittingToAmbiguous does NOT touch a SUBMITTING record that is still fresh', async () => {
  const store = buildInMemoryVisaSubmissionQueueStore();
  const record = await store.createRecord({ groupId: 'g', batchId: 'b', passportIdentityId: 'i' });
  await claimApplicantForSubmission(store, record.id, 9_000);

  await recoverStaleSubmittingToAmbiguous(store, 10_000, 10_000);

  const stored = await store.getRecord(record.id);
  assert.equal(stored?.status, 'SUBMITTING'); // untouched -- only 1000ms old, under the 10000ms threshold
});

test('SAVED, ERROR, and AMBIGUOUS records are never picked up by the stale-SUBMITTING sweep', async () => {
  const store = buildInMemoryVisaSubmissionQueueStore();
  const saved = await store.createRecord({ groupId: 'g', batchId: 'b', passportIdentityId: 'i1' });
  const errored = await store.createRecord({ groupId: 'g', batchId: 'b', passportIdentityId: 'i2' });
  await claimApplicantForSubmission(store, saved.id, 0);
  await finalizeApplicantSubmission(store, saved.id, 'SAVED', 0);
  await claimApplicantForSubmission(store, errored.id, 0);
  await finalizeApplicantSubmission(store, errored.id, 'ERROR', 0);

  const result = await recoverStaleSubmittingToAmbiguous(store, 100_000, 10_000);

  assert.equal(result.movedToAmbiguous.length, 0);
});

test('one record failing unexpectedly during the stale-recovery sweep never blocks the others', async () => {
  const store = buildInMemoryVisaSubmissionQueueStore();
  const good = await store.createRecord({ groupId: 'g', batchId: 'b', passportIdentityId: 'good' });
  const bad = await store.createRecord({ groupId: 'g', batchId: 'b', passportIdentityId: 'bad' });
  await claimApplicantForSubmission(store, good.id, 0);
  await claimApplicantForSubmission(store, bad.id, 0);

  const originalAtomicTransition = store.atomicTransition.bind(store);
  store.atomicTransition = async (recordId, from, to, nowMs) => {
    if (recordId === bad.id && to === 'AMBIGUOUS') {
      throw new Error('simulated unexpected failure for this one record');
    }
    return originalAtomicTransition(recordId, from, to, nowMs);
  };

  const result = await recoverStaleSubmittingToAmbiguous(store, 10_000, 10_000);

  assert.equal(result.movedToAmbiguous.length, 1);
  assert.equal(result.movedToAmbiguous[0]!.id, good.id);
  assert.equal(result.unexpectedFailures.length, 1);
  assert.equal(result.unexpectedFailures[0]!.recordId, bad.id);
});

test('Package 5.24: a findStaleSubmitting failure (the systemic/SELECT-level case) propagates out of recoverStaleSubmittingToAmbiguous, never silently swallowed', async () => {
  // Closes the Package 5.21/5.23 coverage gap: InMemoryStoreFailureInjection's
  // own throwOn: 'findStaleSubmitting' already existed for exactly this,
  // unused until now -- confirmed by this file's own import of
  // buildInMemoryVisaSubmissionQueueStore below taking the injection arg.
  const store = buildInMemoryVisaSubmissionQueueStore({
    throwOn: 'findStaleSubmitting',
    error: new Error('simulated: store/DB unreachable'),
  });

  await assert.rejects(
    () => recoverStaleSubmittingToAmbiguous(store, Date.now(), 10_000),
    /simulated: store\/DB unreachable/,
    'a failure just finding stale candidates must propagate -- never be silently caught, never return a partial/empty result as if nothing were wrong',
  );
});

test('group/batch/applicant isolation: finalizing one record never affects a different record, even with an overlapping applicant id', async () => {
  const store = buildInMemoryVisaSubmissionQueueStore();
  const recordA = await store.createRecord({ groupId: 'group-A', batchId: 'batch-A', passportIdentityId: 'identity-shared' });
  const recordB = await store.createRecord({ groupId: 'group-B', batchId: 'batch-B', passportIdentityId: 'identity-shared' });

  await claimApplicantForSubmission(store, recordA.id, 0);
  await finalizeApplicantSubmission(store, recordA.id, 'SAVED', 0);

  const untouchedB = await store.getRecord(recordB.id);
  assert.equal(untouchedB?.status, 'PENDING'); // recordB's own lifecycle is completely independent
});

test('batch lock: acquire, process, release -- a second worker can only proceed after release', async () => {
  const lockStore = buildInMemoryVisaBatchLockStore();

  const first = await acquireBatchProcessingLock(lockStore, 'batch-1', 'worker-A', 1000);
  assert.deepEqual(first, { outcome: 'acquired' });

  const secondWhileHeld = await acquireBatchProcessingLock(lockStore, 'batch-1', 'worker-B', 1000);
  assert.deepEqual(secondWhileHeld, { outcome: 'already-locked', lockedBy: 'worker-A' });

  await releaseBatchProcessingLock(lockStore, 'batch-1', 'worker-A');

  const secondAfterRelease = await acquireBatchProcessingLock(lockStore, 'batch-1', 'worker-B', 2000);
  assert.deepEqual(secondAfterRelease, { outcome: 'acquired' });
});

test('batch lock: a stale lock (worker crashed without releasing) is force-released by recovery, letting a new worker proceed', async () => {
  const lockStore = buildInMemoryVisaBatchLockStore();
  await acquireBatchProcessingLock(lockStore, 'batch-1', 'worker-A', 0); // then "crashes" -- never releases

  const beforeRecovery = await acquireBatchProcessingLock(lockStore, 'batch-1', 'worker-B', 10_000);
  assert.deepEqual(beforeRecovery, { outcome: 'already-locked', lockedBy: 'worker-A' });

  const recovery = await recoverStaleBatchLocks(lockStore, 10_000, 10_000);
  assert.deepEqual(recovery.released, ['batch-1']);

  const afterRecovery = await acquireBatchProcessingLock(lockStore, 'batch-1', 'worker-B', 10_000);
  assert.deepEqual(afterRecovery, { outcome: 'acquired' });
});

test('batch lock recovery never touches a lock that is not actually stale yet', async () => {
  const lockStore = buildInMemoryVisaBatchLockStore();
  await acquireBatchProcessingLock(lockStore, 'batch-1', 'worker-A', 9_000);

  await recoverStaleBatchLocks(lockStore, 10_000, 10_000);

  const stillHeld = await acquireBatchProcessingLock(lockStore, 'batch-1', 'worker-B', 10_000);
  assert.deepEqual(stillHeld, { outcome: 'already-locked', lockedBy: 'worker-A' });
});

test('Package 5.22: recoverStaleBatchLocks reports alreadyChanged (never released, never an error) when the lock changed before the force-release ran', async () => {
  const lockStore = buildInMemoryVisaBatchLockStore();
  await acquireBatchProcessingLock(lockStore, 'batch-1', 'worker-A', 0); // later found stale

  const racyLockStore = {
    ...lockStore,
    findStaleLocks: async (staleAfterMs: number, nowMs: number) => {
      const stale = await lockStore.findStaleLocks(staleAfterMs, nowMs);
      // Simulate the exact race Package 5.21 found: between this SELECT
      // and recoverStaleBatchLocks's own forceReleaseLock call below, the
      // original lock is released and a DIFFERENT worker re-acquires it.
      await lockStore.releaseLock('batch-1', 'worker-A');
      await lockStore.acquireLock('batch-1', 'worker-C', 5_000);
      return stale;
    },
  };

  const recovery = await recoverStaleBatchLocks(racyLockStore, 10_000, 10_000);
  assert.deepEqual(recovery.released, [], 'the changed lock must never be reported as released');
  assert.deepEqual(recovery.alreadyChanged, ['batch-1'], 'it must be reported as alreadyChanged instead');
  assert.deepEqual(recovery.unexpectedFailures, [], 'a changed lock is not an error');

  const stillHeldByC = await acquireBatchProcessingLock(lockStore, 'batch-1', 'worker-D', 6_000);
  assert.deepEqual(stillHeldByC, { outcome: 'already-locked', lockedBy: 'worker-C' }, "worker-C's fresh lock must survive untouched");
});

test('releasing a batch lock the caller does not hold is rejected -- never lets a wrong worker clear another\'s lock', async () => {
  const lockStore = buildInMemoryVisaBatchLockStore();
  await acquireBatchProcessingLock(lockStore, 'batch-1', 'worker-A', 1000);

  const result = await releaseBatchProcessingLock(lockStore, 'batch-1', 'worker-B');

  assert.deepEqual(result, { outcome: 'not-holder' });
  const stillHeld = await acquireBatchProcessingLock(lockStore, 'batch-1', 'worker-C', 2000);
  assert.deepEqual(stillHeld, { outcome: 'already-locked', lockedBy: 'worker-A' });
});
