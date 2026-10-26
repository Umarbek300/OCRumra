import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildInMemoryVisaBatchLockStore,
  buildInMemoryVisaSubmissionQueueStore,
} from '../src/visa/visaSubmissionQueueStore.js';

test('createRecord starts a new record in PENDING with no claim timestamp', async () => {
  const store = buildInMemoryVisaSubmissionQueueStore();
  const record = await store.createRecord({ groupId: 'group-1', batchId: 'batch-1', passportIdentityId: 'identity-1' });
  assert.equal(record.status, 'PENDING');
  assert.equal(record.claimedAtMs, null);
});

test('getRecord returns null for an unknown id, never throws', async () => {
  const store = buildInMemoryVisaSubmissionQueueStore();
  const record = await store.getRecord('does-not-exist');
  assert.equal(record, null);
});

test('findByApplicant correctly isolates records across different groups/batches/applicants', async () => {
  const store = buildInMemoryVisaSubmissionQueueStore();
  const a = await store.createRecord({ groupId: 'group-A', batchId: 'batch-A', passportIdentityId: 'identity-X' });
  const b = await store.createRecord({ groupId: 'group-B', batchId: 'batch-B', passportIdentityId: 'identity-X' }); // SAME passportIdentityId, DIFFERENT group/batch

  const foundA = await store.findByApplicant('group-A', 'batch-A', 'identity-X');
  const foundB = await store.findByApplicant('group-B', 'batch-B', 'identity-X');
  const foundWrongCombination = await store.findByApplicant('group-A', 'batch-B', 'identity-X');

  assert.equal(foundA?.id, a.id);
  assert.equal(foundB?.id, b.id);
  assert.equal(foundWrongCombination, null); // group-A + batch-B never existed together -- must not match either record
});

test('atomicTransition succeeds when the current status matches expected, and updates claimedAtMs for SUBMITTING', async () => {
  const store = buildInMemoryVisaSubmissionQueueStore();
  const record = await store.createRecord({ groupId: 'g', batchId: 'b', passportIdentityId: 'i' });

  const result = await store.atomicTransition(record.id, 'PENDING', 'SUBMITTING', 1000);

  assert.equal(result.outcome, 'transitioned');
  if (result.outcome !== 'transitioned') throw new Error('unreachable');
  assert.equal(result.record.status, 'SUBMITTING');
  assert.equal(result.record.claimedAtMs, 1000);
});

test('atomicTransition reports a mismatch (never mutates) when the current status does not match expected', async () => {
  const store = buildInMemoryVisaSubmissionQueueStore();
  const record = await store.createRecord({ groupId: 'g', batchId: 'b', passportIdentityId: 'i' });

  const result = await store.atomicTransition(record.id, 'SUBMITTING', 'SAVED', 1000); // record is actually PENDING

  assert.equal(result.outcome, 'current-status-mismatch');
  const unchanged = await store.getRecord(record.id);
  assert.equal(unchanged?.status, 'PENDING');
});

test('atomicTransition on an unknown record id reports record-not-found', async () => {
  const store = buildInMemoryVisaSubmissionQueueStore();
  const result = await store.atomicTransition('nope', 'PENDING', 'SUBMITTING', 1000);
  assert.deepEqual(result, { outcome: 'record-not-found' });
});

test('transitioning to a terminal status clears claimedAtMs back to null', async () => {
  const store = buildInMemoryVisaSubmissionQueueStore();
  const record = await store.createRecord({ groupId: 'g', batchId: 'b', passportIdentityId: 'i' });
  await store.atomicTransition(record.id, 'PENDING', 'SUBMITTING', 1000);

  const result = await store.atomicTransition(record.id, 'SUBMITTING', 'SAVED', 2000);

  assert.equal(result.outcome, 'transitioned');
  if (result.outcome !== 'transitioned') throw new Error('unreachable');
  assert.equal(result.record.claimedAtMs, null);
});

test('findStaleSubmitting only returns SUBMITTING records older than the threshold, never PENDING/terminal ones', async () => {
  const store = buildInMemoryVisaSubmissionQueueStore();
  const stillPending = await store.createRecord({ groupId: 'g', batchId: 'b', passportIdentityId: 'i1' });
  const staleSubmitting = await store.createRecord({ groupId: 'g', batchId: 'b', passportIdentityId: 'i2' });
  const freshSubmitting = await store.createRecord({ groupId: 'g', batchId: 'b', passportIdentityId: 'i3' });
  const alreadySaved = await store.createRecord({ groupId: 'g', batchId: 'b', passportIdentityId: 'i4' });

  await store.atomicTransition(staleSubmitting.id, 'PENDING', 'SUBMITTING', 0); // claimed at t=0
  await store.atomicTransition(freshSubmitting.id, 'PENDING', 'SUBMITTING', 9_000); // claimed at t=9000
  await store.atomicTransition(alreadySaved.id, 'PENDING', 'SUBMITTING', 0);
  await store.atomicTransition(alreadySaved.id, 'SUBMITTING', 'SAVED', 100);

  const stale = await store.findStaleSubmitting(10_000, 10_000); // now=10000, threshold=10000ms

  const staleIds = stale.map((r) => r.id);
  assert.ok(staleIds.includes(staleSubmitting.id));
  assert.ok(!staleIds.includes(freshSubmitting.id)); // 10000-9000=1000 < 10000 threshold
  assert.ok(!staleIds.includes(stillPending.id));
  assert.ok(!staleIds.includes(alreadySaved.id));
});

test('injected failure is thrown, never silently swallowed by the fake itself', async () => {
  const store = buildInMemoryVisaSubmissionQueueStore({ throwOn: 'atomicTransition', error: new Error('simulated store failure') });
  const record = await store.createRecord({ groupId: 'g', batchId: 'b', passportIdentityId: 'i' });

  await assert.rejects(() => store.atomicTransition(record.id, 'PENDING', 'SUBMITTING', 0), /simulated store failure/);
});

test('batch lock: acquiring an unheld lock succeeds', async () => {
  const store = buildInMemoryVisaBatchLockStore();
  const result = await store.acquireLock('batch-1', 'worker-A', 1000);
  assert.deepEqual(result, { outcome: 'acquired' });
});

test('batch lock: a second acquire attempt for the same batch fails while held', async () => {
  const store = buildInMemoryVisaBatchLockStore();
  await store.acquireLock('batch-1', 'worker-A', 1000);
  const result = await store.acquireLock('batch-1', 'worker-B', 1000);
  assert.deepEqual(result, { outcome: 'already-locked', lockedBy: 'worker-A' });
});

test('batch lock: only the holder can release it', async () => {
  const store = buildInMemoryVisaBatchLockStore();
  await store.acquireLock('batch-1', 'worker-A', 1000);

  const wrongHolder = await store.releaseLock('batch-1', 'worker-B');
  assert.deepEqual(wrongHolder, { outcome: 'not-holder' });

  const rightHolder = await store.releaseLock('batch-1', 'worker-A');
  assert.deepEqual(rightHolder, { outcome: 'released' });

  const reacquire = await store.acquireLock('batch-1', 'worker-B', 2000);
  assert.deepEqual(reacquire, { outcome: 'acquired' }); // free again after release
});

test('batch lock: findStaleLocks only returns locks older than the threshold', async () => {
  const store = buildInMemoryVisaBatchLockStore();
  await store.acquireLock('stale-batch', 'worker-A', 0);
  await store.acquireLock('fresh-batch', 'worker-B', 9_000);

  const stale = await store.findStaleLocks(10_000, 10_000);

  assert.deepEqual(stale.map((l) => l.batchId), ['stale-batch']);
});

test('batch lock: forceReleaseLock clears a lock when the given identity exactly matches the current one, regardless of CALLER identity', async () => {
  const store = buildInMemoryVisaBatchLockStore();
  await store.acquireLock('batch-1', 'worker-A', 1000);

  // Nothing about the caller itself needs to match the holder (unlike
  // releaseLock) -- but the lock's own identity (lockedBy/lockedAtMs) must.
  const outcome = await store.forceReleaseLock('batch-1', 'worker-A', 1000);
  assert.deepEqual(outcome, { outcome: 'released' });

  const reacquire = await store.acquireLock('batch-1', 'worker-B', 2000);
  assert.deepEqual(reacquire, { outcome: 'acquired' });
});

test('Package 5.22: forceReleaseLock refuses to clear a lock whose identity no longer matches -- the CURRENT lock (a different worker/time) is left untouched', async () => {
  const store = buildInMemoryVisaBatchLockStore();
  await store.acquireLock('batch-1', 'worker-A', 1000); // later found stale by recovery

  // In the gap, worker-A's lock is legitimately released and a DIFFERENT
  // worker (worker-C) re-acquires the SAME batch -- exactly the race
  // Package 5.21's audit identified.
  await store.releaseLock('batch-1', 'worker-A');
  await store.acquireLock('batch-1', 'worker-C', 5000);

  // Recovery still has worker-A's OLD observed identity from its own
  // earlier findStaleLocks call -- forceReleaseLock must refuse to act on
  // the now-stale identity it was given.
  const outcome = await store.forceReleaseLock('batch-1', 'worker-A', 1000);
  assert.deepEqual(outcome, { outcome: 'not-matched' }, 'the lock changed -- this must never be reported as released');

  const stillHeldByC = await store.acquireLock('batch-1', 'worker-D', 6000);
  assert.deepEqual(stillHeldByC, { outcome: 'already-locked', lockedBy: 'worker-C' }, 'worker-C\'s fresh lock must survive untouched');
});
