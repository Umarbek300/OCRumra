import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pool } from '../src/db/pool.js';
import { assignVisaBatch } from '../src/visa/assignVisaBatch.js';
import { createPassportIdentity } from '../src/db/repositories/passportIdentity.repo.js';
import { cancelWithConflictCheck, createQueueForBatch, createSubmissionAttempt } from '../src/db/repositories/visaSubmissionQueue.repo.js';
import { buildPostgresVisaBatchLockStore, buildPostgresVisaSubmissionQueueStore } from '../src/visa/visaSubmissionQueuePostgresStore.js';

let idCounter = 0;
function uniqueChatId(): number {
  idCounter += 1;
  return -1 * (Date.now() * 1000 + idCounter);
}
function uniquePassportNumber(): string {
  idCounter += 1;
  return `SUBSTORETEST${Date.now()}${idCounter}`;
}

async function createGroup(departureDate = '2026-12-05'): Promise<string> {
  const {
    rows: [group],
  } = await pool.query<{ id: string }>(
    `INSERT INTO groups (name, departure_date, telegram_chat_id) VALUES ($1, $2, $3) RETURNING id`,
    ['Submission Store Test Group', departureDate, uniqueChatId()],
  );
  assert.ok(group);
  return group.id;
}

async function createIdentity(): Promise<string> {
  const identity = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
  assert.ok(identity);
  return identity.id;
}

/** Creates one active applicant AND its queue row, returning everything a test needs. */
async function createQueuedApplicant(groupId: string): Promise<{ applicantId: string; batchId: string; identityId: string }> {
  const identityId = await createIdentity();
  const assignment = await assignVisaBatch(groupId, identityId, 'visitsaudi', '2026-12-05');
  const attempt = await createSubmissionAttempt(assignment.batchId, 'operator:test');
  const created = await createQueueForBatch(assignment.batchId, attempt.id);
  assert.ok(created);
  return { applicantId: assignment.id, batchId: assignment.batchId, identityId };
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

test('buildPostgresVisaSubmissionQueueStore: getRecord/findByApplicant resolve to the SAME record created by createQueueForBatch', async () => {
  const groupId = await createGroup();
  try {
    const { batchId, identityId } = await createQueuedApplicant(groupId);
    const store = buildPostgresVisaSubmissionQueueStore();

    const byApplicant = await store.findByApplicant(groupId, batchId, identityId);
    assert.ok(byApplicant);
    assert.equal(byApplicant.passportIdentityId, identityId);
    assert.equal(byApplicant.status, 'PENDING');

    const byId = await store.getRecord(byApplicant.id);
    assert.ok(byId);
    assert.equal(byId.id, byApplicant.id);
  } finally {
    await cleanupAll([groupId]);
  }
});

test('buildPostgresVisaSubmissionQueueStore: createRecord is idempotent and resolves the SAME applicant as createQueueForBatch would have', async () => {
  const groupId = await createGroup();
  try {
    const identityId = await createIdentity();
    const assignment = await assignVisaBatch(groupId, identityId, 'visitsaudi', '2026-12-05');
    const store = buildPostgresVisaSubmissionQueueStore();

    const first = await store.createRecord({ groupId, batchId: assignment.batchId, passportIdentityId: identityId });
    assert.equal(first.status, 'PENDING');

    const second = await store.createRecord({ groupId, batchId: assignment.batchId, passportIdentityId: identityId });
    assert.equal(second.id, first.id, 'a second createRecord call for the same applicant must never create a duplicate queue row');
  } finally {
    await cleanupAll([groupId]);
  }
});

test('buildPostgresVisaSubmissionQueueStore: atomicTransition moves PENDING -> SUBMITTING -> SAVED and rejects an out-of-order transition', async () => {
  const groupId = await createGroup();
  try {
    const { batchId, identityId } = await createQueuedApplicant(groupId);
    const store = buildPostgresVisaSubmissionQueueStore();
    const record = await store.findByApplicant(groupId, batchId, identityId);
    assert.ok(record);

    const claimed = await store.atomicTransition(record.id, 'PENDING', 'SUBMITTING', Date.now());
    assert.equal(claimed.outcome, 'transitioned');

    const rejected = await store.atomicTransition(record.id, 'PENDING', 'SUBMITTING', Date.now());
    assert.equal(rejected.outcome, 'current-status-mismatch', 'the row is already SUBMITTING -- a second PENDING-claim must be rejected');

    const finalized = await store.atomicTransition(record.id, 'SUBMITTING', 'SAVED', Date.now());
    assert.equal(finalized.outcome, 'transitioned');
    if (finalized.outcome !== 'transitioned') throw new Error('unreachable');
    assert.equal(finalized.record.status, 'SAVED');
  } finally {
    await cleanupAll([groupId]);
  }
});

test('buildPostgresVisaSubmissionQueueStore: findStaleSubmitting finds a SUBMITTING record whose claim is old, never a fresh one', async () => {
  const groupId = await createGroup();
  try {
    const { batchId, identityId } = await createQueuedApplicant(groupId);
    const store = buildPostgresVisaSubmissionQueueStore();
    const record = await store.findByApplicant(groupId, batchId, identityId);
    assert.ok(record);
    await store.atomicTransition(record.id, 'PENDING', 'SUBMITTING', Date.now());

    const freshOnly = await store.findStaleSubmitting(60_000, Date.now());
    assert.equal(freshOnly.find((r) => r.id === record.id), undefined, 'a just-claimed row must not be reported stale yet');

    // Backdate claimed_at directly, bypassing the application entirely --
    // simulates a worker crash long ago, without a real sleep.
    await pool.query(`UPDATE visa_submission_queue SET claimed_at = now() - interval '1 hour' WHERE id = $1`, [record.id]);

    const stale = await store.findStaleSubmitting(60_000, Date.now());
    assert.ok(stale.some((r) => r.id === record.id), 'a SUBMITTING row claimed an hour ago must be reported stale');
  } finally {
    await cleanupAll([groupId]);
  }
});

test('buildPostgresVisaBatchLockStore: acquire/already-locked/release/findStaleLocks/forceRelease', async () => {
  const groupId = await createGroup();
  try {
    const identityId = await createIdentity();
    const assignment = await assignVisaBatch(groupId, identityId, 'visitsaudi', '2026-12-05');
    const lockStore = buildPostgresVisaBatchLockStore();

    const acquired = await lockStore.acquireLock(assignment.batchId, 'worker-a', Date.now());
    assert.equal(acquired.outcome, 'acquired');

    const blocked = await lockStore.acquireLock(assignment.batchId, 'worker-b', Date.now());
    assert.equal(blocked.outcome, 'already-locked');
    assert.equal(blocked.lockedBy, 'worker-a');

    const wrongHolder = await lockStore.releaseLock(assignment.batchId, 'worker-b');
    assert.equal(wrongHolder.outcome, 'not-holder');

    const released = await lockStore.releaseLock(assignment.batchId, 'worker-a');
    assert.equal(released.outcome, 'released');

    const reacquired = await lockStore.acquireLock(assignment.batchId, 'worker-b', Date.now());
    assert.equal(reacquired.outcome, 'acquired', 'a released lock must be acquirable again');

    await pool.query(`UPDATE visa_batch_processing_locks SET locked_at = now() - interval '1 hour' WHERE batch_id = $1`, [
      assignment.batchId,
    ]);
    const stale = await lockStore.findStaleLocks(60_000, Date.now());
    const staleLock = stale.find((l) => l.batchId === assignment.batchId);
    assert.ok(staleLock);

    const forceReleased = await lockStore.forceReleaseLock(staleLock.batchId, staleLock.lockedBy, staleLock.lockedAtMs);
    assert.equal(forceReleased.outcome, 'released', 'the lock is unchanged since findStaleLocks observed it -- must release normally');
    const afterForceRelease = await lockStore.acquireLock(assignment.batchId, 'worker-c', Date.now());
    assert.equal(afterForceRelease.outcome, 'acquired', 'force-released lock must be freely acquirable');
  } finally {
    await cleanupAll([groupId]);
  }
});

test('Package 5.22: forceReleaseLock never deletes a lock that changed between findStaleLocks and the force-release itself -- a different worker\'s FRESH lock on the same batch survives', async () => {
  // Package 5.21's audit finding, now closed and proven against REAL
  // PostgreSQL: recovery observes a stale lock (step 1), but in the gap
  // before it acts, the original holder legitimately releases AND a
  // DIFFERENT worker re-acquires the SAME batch_id (step 2) -- recovery's
  // own force-release call (step 3, using the OLD identity it observed)
  // must refuse to touch the NEW lock (step 4).
  const groupId = await createGroup();
  try {
    const identityId = await createIdentity();
    const assignment = await assignVisaBatch(groupId, identityId, 'visitsaudi', '2026-12-05');
    const lockStore = buildPostgresVisaBatchLockStore();

    // Step 1: recovery's own view of the world -- an old, stale lock.
    const originalAcquire = await lockStore.acquireLock(assignment.batchId, 'worker-original', Date.now());
    assert.equal(originalAcquire.outcome, 'acquired');
    await pool.query(`UPDATE visa_batch_processing_locks SET locked_at = now() - interval '1 hour' WHERE batch_id = $1`, [
      assignment.batchId,
    ]);
    const stale = await lockStore.findStaleLocks(60_000, Date.now());
    const staleLock = stale.find((l) => l.batchId === assignment.batchId);
    assert.ok(staleLock, 'the original lock must be observed as stale before it changes');

    // Step 2: in the gap, the original lock is released and a DIFFERENT
    // worker legitimately re-acquires the SAME batch_id.
    const releaseResult = await lockStore.releaseLock(assignment.batchId, 'worker-original');
    assert.equal(releaseResult.outcome, 'released');
    const newAcquire = await lockStore.acquireLock(assignment.batchId, 'worker-new', Date.now());
    assert.equal(newAcquire.outcome, 'acquired', 'a different worker must be able to legitimately acquire the now-free batch');

    // Step 3: recovery's force-release runs, using the STALE identity it
    // observed in step 1 -- never the fresh one from step 2.
    const forceReleaseOutcome = await lockStore.forceReleaseLock(staleLock.batchId, staleLock.lockedBy, staleLock.lockedAtMs);
    assert.equal(forceReleaseOutcome.outcome, 'not-matched', 'the lock changed since the staleness check -- this must never report released');

    // Step 4: confirm directly against the database that worker-new's
    // fresh lock is completely untouched.
    const { rows } = await pool.query<{ locked_by: string; count: string }>(
      `SELECT locked_by, count(*)::text AS count FROM visa_batch_processing_locks WHERE batch_id = $1 GROUP BY locked_by`,
      [assignment.batchId],
    );
    assert.equal(rows.length, 1, 'exactly one lock row must still exist for this batch');
    assert.equal(rows[0]!.count, '1');
    assert.equal(rows[0]!.locked_by, 'worker-new', "worker-new's lock must survive completely untouched");
  } finally {
    await cleanupAll([groupId]);
  }
});

test('Package 5.22: forceReleaseLock still correctly releases a lock that is EXACTLY as observed, confirming the normal stale-lock cleanup path still works', async () => {
  const groupId = await createGroup();
  try {
    const identityId = await createIdentity();
    const assignment = await assignVisaBatch(groupId, identityId, 'visitsaudi', '2026-12-05');
    const lockStore = buildPostgresVisaBatchLockStore();

    await lockStore.acquireLock(assignment.batchId, 'worker-crashed', Date.now());
    await pool.query(`UPDATE visa_batch_processing_locks SET locked_at = now() - interval '1 hour' WHERE batch_id = $1`, [
      assignment.batchId,
    ]);

    const stale = await lockStore.findStaleLocks(60_000, Date.now());
    const staleLock = stale.find((l) => l.batchId === assignment.batchId);
    assert.ok(staleLock);

    // Nothing changes in the gap this time -- the normal, no-race path.
    const forceReleaseOutcome = await lockStore.forceReleaseLock(staleLock.batchId, staleLock.lockedBy, staleLock.lockedAtMs);
    assert.equal(forceReleaseOutcome.outcome, 'released');

    const { rows } = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM visa_batch_processing_locks WHERE batch_id = $1`, [
      assignment.batchId,
    ]);
    assert.equal(rows[0]?.count, '0', 'the stale lock must be gone, freeing the batch for the next worker');
  } finally {
    await cleanupAll([groupId]);
  }
});

test('buildPostgresVisaBatchLockStore: two TRULY CONCURRENT acquireLock calls (Promise.all, not sequential) for the SAME batch -- only one worker ever wins', async () => {
  // Same reasoning as the dedicated Promise.all claim test added to
  // visaSubmissionQueue.repo.test.ts: the test just above calls
  // acquireLock sequentially (awaited one at a time), which can never
  // exercise the real race window acquireBatchProcessingLock's own
  // INSERT ... ON CONFLICT (batch_id) DO NOTHING (visa_batch_processing_locks'
  // own PRIMARY KEY) is actually meant to guard against two separate
  // `visa:worker` processes/connections racing for the same batch.
  const groupId = await createGroup();
  try {
    const identityId = await createIdentity();
    const assignment = await assignVisaBatch(groupId, identityId, 'visitsaudi', '2026-12-05');
    const lockStore = buildPostgresVisaBatchLockStore();

    const [resultA, resultB] = await Promise.all([
      lockStore.acquireLock(assignment.batchId, 'worker-concurrent-a', Date.now()),
      lockStore.acquireLock(assignment.batchId, 'worker-concurrent-b', Date.now()),
    ]);

    const outcomes = [resultA.outcome, resultB.outcome].sort();
    assert.deepEqual(
      outcomes,
      ['acquired', 'already-locked'],
      'exactly one of the two truly concurrent acquireLock calls must win and the other must see already-locked -- never both, never neither',
    );

    const winnerId = resultA.outcome === 'acquired' ? 'worker-concurrent-a' : 'worker-concurrent-b';
    const loserResult = resultA.outcome === 'already-locked' ? resultA : resultB;
    assert.equal(loserResult.lockedBy, winnerId, "the loser's already-locked result must report the actual winner as holder");

    const { rows } = await pool.query<{ locked_by: string; count: string }>(
      `SELECT locked_by, count(*)::text AS count FROM visa_batch_processing_locks WHERE batch_id = $1 GROUP BY locked_by`,
      [assignment.batchId],
    );
    assert.equal(rows.length, 1, 'exactly one active lock row for this batch -- concurrency never created or duplicated a lock');
    assert.equal(rows[0]!.count, '1');
    assert.equal(rows[0]!.locked_by, winnerId);
  } finally {
    await cleanupAll([groupId]);
  }
});

test('cancelWithConflictCheck (via the repository, exercised through the same batch a Postgres store would use): detecting a conflict records exactly one operator alert', async () => {
  const groupId = await createGroup();
  try {
    const { applicantId, batchId, identityId } = await createQueuedApplicant(groupId);
    const store = buildPostgresVisaSubmissionQueueStore();
    const record = await store.findByApplicant(groupId, batchId, identityId);
    assert.ok(record);
    await store.atomicTransition(record.id, 'PENDING', 'SUBMITTING', Date.now());

    const result = await cancelWithConflictCheck(applicantId, 'cancelled');
    assert.equal(result.conflictDetected, true);

    const { rows } = await pool.query(`SELECT id FROM visa_operator_alerts WHERE visa_submission_queue_id = $1 AND alert_type = 'conflict'`, [
      record.id,
    ]);
    assert.equal(rows.length, 1, 'exactly one conflict alert must be recorded');

    const { rows: statusRows } = await pool.query<{ status: string }>('SELECT status FROM visa_submission_queue WHERE id = $1', [
      record.id,
    ]);
    assert.equal(statusRows[0]?.status, 'SUBMITTING', 'a detected conflict must never auto-reset the submission back to PENDING');
  } finally {
    await cleanupAll([groupId]);
  }
});
