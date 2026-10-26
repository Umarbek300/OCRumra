import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pool } from '../src/db/pool.js';
import { assignVisaBatch } from '../src/visa/assignVisaBatch.js';
import { createPassportIdentity } from '../src/db/repositories/passportIdentity.repo.js';
import type { VisaSubmissionStatus } from '../src/visa/visaSubmissionStatus.js';
import {
  atomicTransition,
  cancelWithConflictCheck,
  claimForSubmission,
  countPendingWithInactiveApplicantForBatch,
  createQueueForBatch,
  createSubmissionAttempt,
  finalizeSubmission,
  flagAmbiguousForReview,
  retireApplicantWithConflictCheckWithClient,
} from '../src/db/repositories/visaSubmissionQueue.repo.js';

let idCounter = 0;
function uniqueChatId(): number {
  idCounter += 1;
  return -1 * (Date.now() * 1000 + idCounter);
}
function uniquePassportNumber(): string {
  idCounter += 1;
  return `SUBQUEUETEST${Date.now()}${idCounter}`;
}

async function createGroup(departureDate = '2026-11-05'): Promise<string> {
  const {
    rows: [group],
  } = await pool.query<{ id: string }>(
    `INSERT INTO groups (name, departure_date, telegram_chat_id) VALUES ($1, $2, $3) RETURNING id`,
    ['Submission Queue Test Group', departureDate, uniqueChatId()],
  );
  assert.ok(group);
  return group.id;
}

async function createIdentity(): Promise<string> {
  const identity = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
  assert.ok(identity);
  return identity.id;
}

/** Creates one active visa_batch_applicants row via the already-tested assignVisaBatch, returning its id and batch id. */
async function createActiveApplicant(groupId: string): Promise<{ applicantId: string; batchId: string }> {
  const identityId = await createIdentity();
  const assignment = await assignVisaBatch(groupId, identityId, 'visitsaudi', '2026-11-05');
  return { applicantId: assignment.id, batchId: assignment.batchId };
}

/**
 * Polls pg_blocking_pids (the documented, reliable way to ask Postgres
 * itself "is backend X currently blocked on a lock held by backend Y",
 * rather than guessing from elapsed time) until some OTHER backend reports
 * blockerPid as one of its blockers, or timeoutMs elapses. The timeout
 * exists ONLY to prevent an indefinite hang if something is wrong (e.g. the
 * lock was never actually taken) -- a true negative is reported as `false`,
 * never silently treated as a pass.
 */
async function isBlockedBy(blockerPid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await pool.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity WHERE pid <> $1 AND $1 = ANY(pg_blocking_pids(pid))`,
      [blockerPid],
    );
    if (rows.length > 0) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

/**
 * Polls pg_blocking_pids (same documented, fact-based technique as
 * isBlockedBy above) until at least minCount DISTINCT backends report
 * blockerPid as one of their blockers, returning the actual Set found (its
 * size is the fact being reported, not a bare boolean).
 *
 * Unlike a passive "catch two connections racing naturally" approach
 * (Package 5.4.7's own first, abandoned attempt -- that race resolved in
 * ~3-5ms on local Postgres, far too fast for any safe polling interval to
 * reliably observe, making THAT test flaky even though the underlying
 * claim behavior was always correct), this function is only ever used
 * against a condition the CALLER holds open indefinitely via its own,
 * separate, uncommitted transaction -- so there is no narrow timing window
 * to miss: the two backends stay blocked for exactly as long as the caller
 * keeps its lock, i.e. as long as this poll takes. The bounded timeout
 * exists purely as a hang-guard (e.g. if the expected blocking somehow
 * never occurs); it is never the thing determining whether blocking
 * "really" happened.
 */
async function waitForBlockedCount(blockerPid: number, minCount: number, timeoutMs: number): Promise<Set<number>> {
  const deadline = Date.now() + timeoutMs;
  let lastSeen = new Set<number>();
  while (Date.now() < deadline) {
    const { rows } = await pool.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity WHERE pid <> $1 AND $1 = ANY(pg_blocking_pids(pid))`,
      [blockerPid],
    );
    lastSeen = new Set(rows.map((row) => row.pid));
    if (lastSeen.size >= minCount) {
      return lastSeen;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return lastSeen;
}

async function cleanupAll(groupIds: string[]): Promise<void> {
  for (const groupId of groupIds) {
    await pool.query(
      `DELETE FROM visa_submission_reviews WHERE visa_submission_queue_id IN (
         SELECT id FROM visa_submission_queue WHERE group_id = $1
       )`,
      [groupId],
    );
    await pool.query(
      `DELETE FROM visa_operator_alerts WHERE visa_submission_queue_id IN (
         SELECT id FROM visa_submission_queue WHERE group_id = $1
       )`,
      [groupId],
    );
    await pool.query(
      `DELETE FROM visa_submission_sheet_sync_jobs WHERE visa_submission_queue_id IN (
         SELECT id FROM visa_submission_queue WHERE group_id = $1
       )`,
      [groupId],
    );
    await pool.query(`DELETE FROM visa_submission_queue WHERE group_id = $1`, [groupId]);
    await pool.query(`DELETE FROM visa_submission_attempts WHERE batch_id IN (SELECT id FROM visa_batches WHERE group_id = $1)`, [
      groupId,
    ]);
    await pool.query(`DELETE FROM visa_batch_applicants WHERE group_id = $1`, [groupId]);
    await pool.query(`DELETE FROM visa_batches WHERE group_id = $1`, [groupId]);
    await pool.query(
      `DELETE FROM passport_identity WHERE id IN (
         SELECT passport_identity_id FROM visa_batch_applicants WHERE group_id = $1
       )`,
      [groupId],
    );
    await pool.query(`DELETE FROM groups WHERE id = $1`, [groupId]);
  }
}

test('createSubmissionAttempt is idempotent per batch -- a second call returns the SAME row, never a duplicate', async () => {
  const groupId = await createGroup();
  try {
    const { batchId } = await createActiveApplicant(groupId);

    const first = await createSubmissionAttempt(batchId, 'operator:test');
    const second = await createSubmissionAttempt(batchId, 'operator:test-2');

    assert.equal(first.id, second.id, 'batch_id is UNIQUE -- the second call must return the existing attempt, not create a new one');
    assert.equal(first.status, 'pending');
    assert.equal(second.requestedBy, 'operator:test', 'the EXISTING row (first requester) must be returned unchanged');

    const { rows } = await pool.query('SELECT id FROM visa_submission_attempts WHERE batch_id = $1', [batchId]);
    assert.equal(rows.length, 1);
  } finally {
    await cleanupAll([groupId]);
  }
});

test('createQueueForBatch creates one PENDING queue row per active applicant and marks the attempt queued', async () => {
  const groupId = await createGroup();
  try {
    const { applicantId, batchId } = await createActiveApplicant(groupId);
    const attempt = await createSubmissionAttempt(batchId, 'operator:test');

    const created = await createQueueForBatch(batchId, attempt.id);
    assert.ok(created);
    assert.equal(created.length, 1);
    assert.equal(created[0]?.visaBatchApplicantId, applicantId);
    assert.equal(created[0]?.status, 'PENDING');

    const { rows: attemptRows } = await pool.query<{ status: string }>('SELECT status FROM visa_submission_attempts WHERE id = $1', [
      attempt.id,
    ]);
    assert.equal(attemptRows[0]?.status, 'queued');
  } finally {
    await cleanupAll([groupId]);
  }
});

test('createQueueForBatch is idempotent per batch -- a second call returns null and creates no duplicate rows', async () => {
  const groupId = await createGroup();
  try {
    const { batchId } = await createActiveApplicant(groupId);
    const attempt = await createSubmissionAttempt(batchId, 'operator:test');

    const first = await createQueueForBatch(batchId, attempt.id);
    assert.ok(first);
    const second = await createQueueForBatch(batchId, attempt.id);
    assert.equal(second, null, 'a batch already queued must never be queued a second time');

    const { rows } = await pool.query('SELECT id FROM visa_submission_queue WHERE batch_id = $1', [batchId]);
    assert.equal(rows.length, 1);
  } finally {
    await cleanupAll([groupId]);
  }
});

test('createQueueForBatch only queues ACTIVE applicants, never a cancelled one', async () => {
  const groupId = await createGroup();
  try {
    const { applicantId, batchId } = await createActiveApplicant(groupId);
    await pool.query(`UPDATE visa_batch_applicants SET status = 'cancelled' WHERE id = $1`, [applicantId]);
    const attempt = await createSubmissionAttempt(batchId, 'operator:test');

    const created = await createQueueForBatch(batchId, attempt.id);
    assert.ok(created);
    assert.equal(created.length, 0, 'a cancelled applicant must never get a queue row');
  } finally {
    await cleanupAll([groupId]);
  }
});

test('claimForSubmission atomically moves PENDING -> SUBMITTING, and a second claim on the same row fails', async () => {
  const groupId = await createGroup();
  try {
    const { batchId } = await createActiveApplicant(groupId);
    const attempt = await createSubmissionAttempt(batchId, 'operator:test');
    const [queueRow] = (await createQueueForBatch(batchId, attempt.id)) ?? [];
    assert.ok(queueRow);

    const claimed = await claimForSubmission(queueRow.id);
    assert.ok(claimed);
    assert.equal(claimed.status, 'SUBMITTING');
    assert.ok(claimed.claimedAt);

    const secondClaim = await claimForSubmission(queueRow.id);
    assert.equal(secondClaim, null, 'a row already SUBMITTING must never be claimed twice');
  } finally {
    await cleanupAll([groupId]);
  }
});

test('claimForSubmission: two TRULY CONCURRENT claims (Promise.all, not sequential) on the SAME PENDING row -- only one ever wins', async () => {
  // Regression/confidence test for claimForSubmission's own atomic
  // UPDATE ... WHERE status = 'PENDING' (visaSubmissionQueue.repo.ts) under
  // REAL concurrent PostgreSQL callers -- every other claim test in this
  // file (including the one just above) calls claimForSubmission
  // sequentially (awaited one at a time), which can never exercise a real
  // race window at all, exactly like assignVisaBatch.ts's own dedicated
  // concurrency test had to be added separately from its sequential ones.
  const groupId = await createGroup();
  try {
    const { batchId } = await createActiveApplicant(groupId);
    const attempt = await createSubmissionAttempt(batchId, 'operator:test');
    const [queueRow] = (await createQueueForBatch(batchId, attempt.id)) ?? [];
    assert.ok(queueRow);

    const [resultA, resultB] = await Promise.all([claimForSubmission(queueRow.id), claimForSubmission(queueRow.id)]);

    const winners = [resultA, resultB].filter((r) => r !== null);
    assert.equal(winners.length, 1, 'exactly one of the two truly concurrent claims must win -- never both, never neither');
    assert.equal(winners[0]!.status, 'SUBMITTING');
    assert.ok(winners[0]!.claimedAt);

    const { rows } = await pool.query<{ status: string; count: string }>(
      `SELECT status, count(*)::text AS count FROM visa_submission_queue WHERE id = $1 GROUP BY status`,
      [queueRow.id],
    );
    assert.equal(rows.length, 1, 'still exactly one queue row for this applicant -- concurrency never created or duplicated a row');
    assert.equal(rows[0]!.status, 'SUBMITTING');
    assert.equal(rows[0]!.count, '1');
  } finally {
    await cleanupAll([groupId]);
  }
});

test('Package 5.9: claimForSubmission now refuses a PENDING row whose applicant is no longer active, leaving the row untouched', async () => {
  // Before Package 5.9, claimForSubmission ran its own standalone
  // UPDATE ... WHERE status = 'PENDING' with NO applicant-active check at
  // all -- it would have claimed this row. It now delegates to
  // atomicTransition (-> claimTransitionToSubmitting), the same
  // lock-order-proven path claimApplicantForSubmission's own production
  // claim already uses, so a retired applicant's row must be left PENDING.
  const groupId = await createGroup();
  const client = await pool.connect();
  try {
    const { applicantId, batchId } = await createActiveApplicant(groupId);
    const attempt = await createSubmissionAttempt(batchId, 'operator:test');
    const [queueRow] = (await createQueueForBatch(batchId, attempt.id)) ?? [];
    assert.ok(queueRow);

    await client.query('BEGIN');
    const retireResult = await retireApplicantWithConflictCheckWithClient(client, applicantId, 'removed', 'test: Package 5.9 inactive-claim guard');
    await client.query('COMMIT');
    assert.equal(retireResult.retired, true);

    const claimed = await claimForSubmission(queueRow.id);
    assert.equal(claimed, null, 'claimForSubmission must now refuse a row whose applicant is inactive');

    const { rows } = await pool.query<{ status: string }>('SELECT status FROM visa_submission_queue WHERE id = $1', [queueRow.id]);
    assert.equal(rows[0]?.status, 'PENDING', 'a refused claim must leave the queue row exactly where it was');
  } finally {
    client.release();
    await cleanupAll([groupId]);
  }
});

test('finalizeSubmission atomically moves SUBMITTING -> SAVED, and cannot finalize a non-SUBMITTING row', async () => {
  const groupId = await createGroup();
  try {
    const { batchId } = await createActiveApplicant(groupId);
    const attempt = await createSubmissionAttempt(batchId, 'operator:test');
    const [queueRow] = (await createQueueForBatch(batchId, attempt.id)) ?? [];
    assert.ok(queueRow);

    const neverClaimed = await finalizeSubmission(queueRow.id, 'SAVED');
    assert.equal(neverClaimed, null, 'a PENDING row was never claimed, so it cannot be finalized');

    await claimForSubmission(queueRow.id);
    const finalized = await finalizeSubmission(queueRow.id, 'SAVED');
    assert.ok(finalized);
    assert.equal(finalized.status, 'SAVED');
    assert.equal(finalized.claimedAt, null, 'claimed_at is cleared once a submission reaches a terminal state');
  } finally {
    await cleanupAll([groupId]);
  }
});

test('cancelWithConflictCheck cancels a plain ACTIVE applicant with no conflict when nothing is SUBMITTING', async () => {
  const groupId = await createGroup();
  try {
    const { applicantId } = await createActiveApplicant(groupId);

    const result = await cancelWithConflictCheck(applicantId, 'cancelled');
    assert.equal(result.cancelled, true);
    assert.equal(result.conflictDetected, false);

    const { rows } = await pool.query<{ status: string }>('SELECT status FROM visa_batch_applicants WHERE id = $1', [applicantId]);
    assert.equal(rows[0]?.status, 'cancelled');
  } finally {
    await cleanupAll([groupId]);
  }
});

test('cancelWithConflictCheck is a safe no-op on an already-cancelled applicant', async () => {
  const groupId = await createGroup();
  try {
    const { applicantId } = await createActiveApplicant(groupId);
    const first = await cancelWithConflictCheck(applicantId, 'cancelled');
    assert.equal(first.cancelled, true);

    const second = await cancelWithConflictCheck(applicantId, 'cancelled');
    assert.equal(second.cancelled, false, 'an already-cancelled applicant has nothing left to cancel');
    assert.equal(second.conflictDetected, false);
  } finally {
    await cleanupAll([groupId]);
  }
});

test('cancelWithConflictCheck detects and records a conflict when the queue row is SUBMITTING', async () => {
  const groupId = await createGroup();
  try {
    const { applicantId, batchId } = await createActiveApplicant(groupId);
    const attempt = await createSubmissionAttempt(batchId, 'operator:test');
    const [queueRow] = (await createQueueForBatch(batchId, attempt.id)) ?? [];
    assert.ok(queueRow);
    await claimForSubmission(queueRow.id);

    const result = await cancelWithConflictCheck(applicantId, 'cancelled');
    assert.equal(result.cancelled, true, 'the applicant is still cancelled -- the conflict is recorded, not blocked');
    assert.equal(result.conflictDetected, true);

    const { rows } = await pool.query<{ conflict_detected_at: string | null }>(
      'SELECT conflict_detected_at FROM visa_submission_queue WHERE id = $1',
      [queueRow.id],
    );
    assert.ok(rows[0]?.conflict_detected_at, 'conflict_detected_at must be set once the conflict is found');
  } finally {
    await cleanupAll([groupId]);
  }
});

test('atomicTransition (the REAL production claim path, PENDING -> SUBMITTING): a claim racing a concurrent in-flight cancellation never wins, using two REAL separate PostgreSQL connections', async () => {
  // This is not claimForSubmission's own Promise.all test (line ~177
  // above) -- that proves two claims can never both win. This proves the
  // NEW, narrower guarantee: a cancellation that is mid-transaction,
  // already holding cancelWithConflictCheck's own locks (visa_batch_applicants
  // FOR UPDATE, then visa_submission_queue FOR UPDATE -- the exact lock
  // order that function's own doc comment requires), forces a concurrent
  // claim to block and then lose, rather than racing past it. The claim
  // is genuinely blocked at the database level (confirmed via
  // pg_blocking_pids, not inferred from timing) BEFORE the cancellation
  // commits -- this is what distinguishes this test from a sequential
  // "cancel then claim" test, which this codebase's EXISTS-based fix would
  // pass trivially even without any lock interaction at all.
  const groupId = await createGroup();
  const clientA = await pool.connect();
  let clientAInTransaction = false;
  let claimPromise: ReturnType<typeof atomicTransition> | undefined;
  try {
    const { applicantId, batchId } = await createActiveApplicant(groupId);
    const attempt = await createSubmissionAttempt(batchId, 'operator:test');
    const [queueRow] = (await createQueueForBatch(batchId, attempt.id)) ?? [];
    assert.ok(queueRow);

    await clientA.query('BEGIN');
    clientAInTransaction = true;
    // Same lock order cancelWithConflictCheck itself uses -- applicants
    // FIRST, then the queue row -- never reversed.
    await clientA.query('SELECT id, status FROM visa_batch_applicants WHERE id = $1 FOR UPDATE', [applicantId]);
    await clientA.query('SELECT id, status FROM visa_submission_queue WHERE visa_batch_applicant_id = $1 FOR UPDATE', [applicantId]);

    const {
      rows: [backend],
    } = await clientA.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    assert.ok(backend);
    const clientAPid = backend.pid;

    // Started, deliberately not yet awaited: this is the exact call the
    // production claim path (claimApplicantForSubmission -> requestTransition
    // -> store.atomicTransition) makes.
    claimPromise = atomicTransition(queueRow.id, 'PENDING', 'SUBMITTING');

    const wasBlocked = await isBlockedBy(clientAPid, 5000);
    assert.equal(
      wasBlocked,
      true,
      'could not confirm via pg_blocking_pids that the claim statement was genuinely blocked by clientA\'s held FOR UPDATE locks -- ' +
        'this test does NOT demonstrate the concurrency guarantee without that confirmation, and must not be treated as having proven it',
    );

    // Only now, with the claim provably waiting on clientA's locks, finish
    // the cancellation exactly as cancelWithConflictCheck's own write does.
    await clientA.query(`UPDATE visa_batch_applicants SET status = 'cancelled' WHERE id = $1`, [applicantId]);
    await clientA.query('COMMIT');
    clientAInTransaction = false;

    const claimResult = await claimPromise;
    claimPromise = undefined;
    assert.notEqual(
      claimResult.outcome,
      'transitioned',
      'a claim that was blocked behind an in-flight cancellation must never win once that cancellation commits',
    );

    const { rows: applicantRows } = await pool.query<{ status: string }>('SELECT status FROM visa_batch_applicants WHERE id = $1', [
      applicantId,
    ]);
    assert.equal(applicantRows[0]?.status, 'cancelled');

    const { rows: queueRows } = await pool.query<{ status: string }>('SELECT status FROM visa_submission_queue WHERE id = $1', [
      queueRow.id,
    ]);
    assert.equal(
      queueRows[0]?.status,
      'PENDING',
      'the rejected claim must leave the queue row exactly where cancelWithConflictCheck left it -- never advanced to SUBMITTING',
    );
  } finally {
    if (clientAInTransaction) {
      await clientA.query('ROLLBACK').catch(() => {});
    }
    if (claimPromise) {
      await claimPromise.catch(() => {});
    }
    clientA.release();
    await cleanupAll([groupId]);
  }
});

test('atomicTransition claims successfully first, THEN cancelWithConflictCheck detects the conflict and records a durable operator alert', async () => {
  const groupId = await createGroup();
  try {
    const { applicantId, batchId } = await createActiveApplicant(groupId);
    const attempt = await createSubmissionAttempt(batchId, 'operator:test');
    const [queueRow] = (await createQueueForBatch(batchId, attempt.id)) ?? [];
    assert.ok(queueRow);

    const claimed = await atomicTransition(queueRow.id, 'PENDING', 'SUBMITTING');
    if (claimed.outcome !== 'transitioned') {
      throw new Error(`expected the claim to succeed for a still-active applicant, got outcome: ${claimed.outcome}`);
    }
    assert.equal(claimed.record.status, 'SUBMITTING');

    const result = await cancelWithConflictCheck(applicantId, 'cancelled');
    assert.equal(result.cancelled, true, 'the applicant is still cancelled -- a conflict is recorded, never blocked');
    assert.equal(result.conflictDetected, true, 'a claim that already succeeded before cancellation must be reported as a conflict');

    const { rows: queueRows } = await pool.query<{ conflict_detected_at: string | null }>(
      'SELECT conflict_detected_at FROM visa_submission_queue WHERE id = $1',
      [queueRow.id],
    );
    assert.ok(queueRows[0]?.conflict_detected_at, 'conflict_detected_at must be set');

    const { rows: alertRows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM visa_operator_alerts WHERE visa_submission_queue_id = $1 AND alert_type = 'conflict'`,
      [queueRow.id],
    );
    assert.equal(alertRows[0]?.count, '1', 'exactly one durable conflict alert must be recorded for this queue row');
  } finally {
    await cleanupAll([groupId]);
  }
});

test('claim takes the applicant FOR SHARE lock first: a concurrent cancelWithConflictCheck genuinely blocks on it, then correctly detects the conflict once claim commits', async () => {
  // Mirror image of the earlier "cancel locks first" test: here CLIENT A
  // plays the role of claimTransitionToSubmitting's own transaction,
  // manually driven step by step so the test can hold it open (BEGIN ->
  // FOR SHARE on the applicant -> the queue UPDATE itself -> still no
  // COMMIT) long enough to prove, via pg_blocking_pids, that
  // cancelWithConflictCheck's own `FOR UPDATE` on that SAME applicant row
  // genuinely blocks behind it (FOR SHARE and FOR UPDATE conflict), and
  // only resolves -- correctly detecting the conflict, since the queue row
  // is by then SUBMITTING -- after the claim-equivalent transaction commits.
  const groupId = await createGroup();
  const clientA = await pool.connect();
  let clientAInTransaction = false;
  let cancelPromise: ReturnType<typeof cancelWithConflictCheck> | undefined;
  try {
    const { applicantId, batchId } = await createActiveApplicant(groupId);
    const attempt = await createSubmissionAttempt(batchId, 'operator:test');
    const [queueRow] = (await createQueueForBatch(batchId, attempt.id)) ?? [];
    assert.ok(queueRow);

    await clientA.query('BEGIN');
    clientAInTransaction = true;
    await clientA.query('SELECT status FROM visa_batch_applicants WHERE id = $1 FOR SHARE', [applicantId]);
    const { rows: claimedRows } = await clientA.query<{ status: string }>(
      `UPDATE visa_submission_queue SET status = 'SUBMITTING', claimed_at = now(), attempts = attempts + 1
       WHERE id = $1 AND status = 'PENDING' RETURNING status`,
      [queueRow.id],
    );
    assert.equal(claimedRows[0]?.status, 'SUBMITTING');

    const {
      rows: [backend],
    } = await clientA.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    assert.ok(backend);
    const clientAPid = backend.pid;

    cancelPromise = cancelWithConflictCheck(applicantId, 'cancelled');

    const wasBlocked = await isBlockedBy(clientAPid, 5000);
    assert.equal(
      wasBlocked,
      true,
      'could not confirm via pg_blocking_pids that cancelWithConflictCheck was genuinely blocked by the claim-equivalent FOR SHARE lock -- ' +
        'this test does NOT demonstrate the ordering guarantee without that confirmation',
    );

    await clientA.query('COMMIT');
    clientAInTransaction = false;

    const cancelResult = await cancelPromise;
    cancelPromise = undefined;
    assert.equal(cancelResult.cancelled, true);
    assert.equal(cancelResult.conflictDetected, true, 'cancel must detect the conflict once it sees the now-committed SUBMITTING queue row');

    const { rows: queueRows } = await pool.query<{ status: string; conflict_detected_at: string | null }>(
      'SELECT status, conflict_detected_at FROM visa_submission_queue WHERE id = $1',
      [queueRow.id],
    );
    assert.equal(queueRows[0]?.status, 'SUBMITTING', 'cancel must never reset an in-flight submission back to PENDING');
    assert.ok(queueRows[0]?.conflict_detected_at);

    const { rows: alertRows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM visa_operator_alerts WHERE visa_submission_queue_id = $1 AND alert_type = 'conflict'`,
      [queueRow.id],
    );
    assert.equal(alertRows[0]?.count, '1');
  } finally {
    if (clientAInTransaction) {
      await clientA.query('ROLLBACK').catch(() => {});
    }
    if (cancelPromise) {
      await cancelPromise.catch(() => {});
    }
    clientA.release();
    await cleanupAll([groupId]);
  }
});

test('atomicTransition (PENDING -> SUBMITTING): a mid-transaction error rolls back cleanly -- queue stays PENDING, the applicant lock is released, and a subsequent claim still succeeds', async () => {
  const groupId = await createGroup();
  try {
    const { batchId } = await createActiveApplicant(groupId);
    const attempt = await createSubmissionAttempt(batchId, 'operator:test');
    const [queueRow] = (await createQueueForBatch(batchId, attempt.id)) ?? [];
    assert.ok(queueRow);

    // An invalid enum value for expectedCurrentStatus forces a genuine
    // PostgreSQL error (invalid input value for enum visa_submission_status)
    // on the claim's own final UPDATE statement -- AFTER the applicant's
    // FOR SHARE lock has already been taken and the active check has
    // already passed, exercising exactly the "error after the lock, before
    // COMMIT" path this test needs, without touching any production code.
    await assert.rejects(() => atomicTransition(queueRow.id, 'NOT_A_REAL_STATUS' as VisaSubmissionStatus, 'SUBMITTING'));

    const { rows: afterRollback } = await pool.query<{ status: string }>('SELECT status FROM visa_submission_queue WHERE id = $1', [
      queueRow.id,
    ]);
    assert.equal(afterRollback[0]?.status, 'PENDING', 'a rolled-back claim transaction must leave the queue row exactly as it was');

    const retried = await atomicTransition(queueRow.id, 'PENDING', 'SUBMITTING');
    assert.equal(retried.outcome, 'transitioned', 'the applicant lock must have been released by ROLLBACK -- a subsequent claim must succeed normally');
  } finally {
    await cleanupAll([groupId]);
  }
});

test('atomicTransition (PENDING -> SUBMITTING, the NEW transactional claim path): two TRULY CONCURRENT claims on the SAME queue row -- exactly one wins, using two deterministically-confirmed separate PostgreSQL connections', async () => {
  // Closes the test-coverage gap Package 5.4.6's independent audit flagged:
  // the ONLY pre-existing "two truly concurrent claims" test in this file
  // (see claimForSubmission's own Promise.all test above) exercises
  // claimForSubmission, never atomicTransition/claimTransitionToSubmitting
  // -- the function Package 5.4.5 actually rewrote into a full transaction
  // with its own applicant-row lock. This test exercises THAT function
  // directly, via the real, exported atomicTransition entry point (the
  // exact one the production claim path calls), under genuine concurrency.
  //
  // Package 5.4.7's FIRST version of this test tried to catch two claims
  // racing naturally, with no third party involved -- that race resolves
  // in ~3-5ms on local Postgres (confirmed via a standalone diagnostic),
  // far too fast for any passive polling interval to reliably observe,
  // which made THAT test flaky even though the underlying claim behavior
  // was always correct. This version instead makes a THIRD connection
  // (clientC) hold the applicant row's lock deterministically -- turning
  // "are two separate connections genuinely involved" from a narrow timing
  // race into a durable, poll-until-true fact (pg_blocking_pids, the same
  // documented technique the earlier cancel/claim ordering tests already
  // use), with the timeout acting ONLY as a hang-guard, never as the thing
  // deciding the result.
  const groupId = await createGroup();
  const clientC = await pool.connect();
  let clientCInTransaction = false;
  let claimPromiseA: ReturnType<typeof atomicTransition> | undefined;
  let claimPromiseB: ReturnType<typeof atomicTransition> | undefined;
  try {
    const { applicantId, batchId } = await createActiveApplicant(groupId);
    const attempt = await createSubmissionAttempt(batchId, 'operator:test');
    const [queueRow] = (await createQueueForBatch(batchId, attempt.id)) ?? [];
    assert.ok(queueRow);

    await clientC.query('BEGIN');
    clientCInTransaction = true;
    // FOR UPDATE conflicts with claimTransitionToSubmitting's own FOR
    // SHARE on this exact applicant row -- holding it here forces BOTH
    // claims below to queue up waiting, deterministically, for exactly as
    // long as this transaction stays open (no race against the clock).
    await clientC.query('SELECT status FROM visa_batch_applicants WHERE id = $1 FOR UPDATE', [applicantId]);

    const {
      rows: [backend],
    } = await clientC.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    assert.ok(backend);
    const clientCPid = backend.pid;

    claimPromiseA = atomicTransition(queueRow.id, 'PENDING', 'SUBMITTING');
    claimPromiseB = atomicTransition(queueRow.id, 'PENDING', 'SUBMITTING');

    const blockedPids = await waitForBlockedCount(clientCPid, 2, 5000);
    assert.equal(
      blockedPids.size,
      2,
      `expected exactly two DISTINCT PostgreSQL backends to be genuinely blocked behind clientC's held lock -- observed ${blockedPids.size} ` +
        `(pids: ${[...blockedPids].join(', ')}); without this confirmation the test cannot be trusted as a real two-connection proof`,
    );

    // Only now, with both claims provably queued on two separate
    // connections, release the lock and let them race for real.
    await clientC.query('COMMIT');
    clientCInTransaction = false;

    const [resultA, resultB] = await Promise.all([claimPromiseA, claimPromiseB]);
    claimPromiseA = undefined;
    claimPromiseB = undefined;

    const outcomes = [resultA.outcome, resultB.outcome].sort();
    assert.deepEqual(
      outcomes,
      ['current-status-mismatch', 'transitioned'],
      'exactly one of the two truly concurrent claims must win the PENDING -> SUBMITTING transition -- never both, never neither',
    );

    const { rows } = await pool.query<{ status: string; attempts: number; count: string }>(
      `SELECT status, attempts, count(*)::text AS count FROM visa_submission_queue WHERE id = $1 GROUP BY status, attempts`,
      [queueRow.id],
    );
    assert.equal(rows.length, 1, 'still exactly one queue row for this applicant -- concurrency never created or duplicated a row');
    assert.equal(rows[0]?.status, 'SUBMITTING');
    assert.equal(rows[0]?.attempts, 1, 'attempts must increment exactly once -- never twice -- despite two concurrent claim attempts');
    assert.equal(rows[0]?.count, '1');
  } finally {
    if (clientCInTransaction) {
      await clientC.query('ROLLBACK').catch(() => {});
    }
    if (claimPromiseA) {
      await claimPromiseA.catch(() => {});
    }
    if (claimPromiseB) {
      await claimPromiseB.catch(() => {});
    }
    clientC.release();
    await cleanupAll([groupId]);
  }
});

test('retireApplicantWithConflictCheckWithClient: retires an ACTIVE applicant with no conflict when the queue is PENDING or absent, and is a safe no-op when already inactive', async () => {
  const groupId = await createGroup();
  const client = await pool.connect();
  try {
    const { applicantId } = await createActiveApplicant(groupId);

    await client.query('BEGIN');
    const result = await retireApplicantWithConflictCheckWithClient(client, applicantId, 'removed', 'test: no queue at all');
    await client.query('COMMIT');

    assert.equal(result.retired, true);
    assert.equal(result.conflictDetected, false);

    const { rows } = await pool.query<{ status: string }>('SELECT status FROM visa_batch_applicants WHERE id = $1', [applicantId]);
    assert.equal(rows[0]?.status, 'removed');

    await client.query('BEGIN');
    const second = await retireApplicantWithConflictCheckWithClient(client, applicantId, 'removed', 'test: already inactive');
    await client.query('COMMIT');
    assert.equal(second.retired, false, 'an already-inactive applicant has nothing left to retire');
    assert.equal(second.conflictDetected, false);
  } finally {
    client.release();
    await cleanupAll([groupId]);
  }
});

test('retireApplicantWithConflictCheckWithClient: a PENDING queue row is left untouched by retirement, but becomes unclaimable once the applicant is retired', async () => {
  const groupId = await createGroup();
  const client = await pool.connect();
  try {
    const { applicantId, batchId } = await createActiveApplicant(groupId);
    const attempt = await createSubmissionAttempt(batchId, 'operator:test');
    const [queueRow] = (await createQueueForBatch(batchId, attempt.id)) ?? [];
    assert.ok(queueRow);

    await client.query('BEGIN');
    const result = await retireApplicantWithConflictCheckWithClient(client, applicantId, 'removed', 'test: PENDING queue');
    await client.query('COMMIT');

    assert.equal(result.retired, true);
    assert.equal(result.conflictDetected, false, 'a PENDING queue row is never a conflict');

    const { rows: queueRowsAfterRetire } = await pool.query<{ status: string }>('SELECT status FROM visa_submission_queue WHERE id = $1', [
      queueRow.id,
    ]);
    assert.equal(queueRowsAfterRetire[0]?.status, 'PENDING', 'retirement must never touch the queue row itself');

    const claim = await atomicTransition(queueRow.id, 'PENDING', 'SUBMITTING');
    assert.notEqual(
      claim.outcome,
      'transitioned',
      'a worker must never be able to move a retired applicant\'s queue row into SUBMITTING -- submission must never start',
    );

    const { rows: queueRowsAfterClaim } = await pool.query<{ status: string }>('SELECT status FROM visa_submission_queue WHERE id = $1', [
      queueRow.id,
    ]);
    assert.equal(queueRowsAfterClaim[0]?.status, 'PENDING', 'the rejected claim must leave the queue row exactly where it was');
  } finally {
    client.release();
    await cleanupAll([groupId]);
  }
});

test('retireApplicantWithConflictCheckWithClient: a SUBMITTING queue row triggers a conflict -- conflict_detected_at is set and exactly one durable operator alert is recorded', async () => {
  const groupId = await createGroup();
  const client = await pool.connect();
  try {
    const { applicantId, batchId } = await createActiveApplicant(groupId);
    const attempt = await createSubmissionAttempt(batchId, 'operator:test');
    const [queueRow] = (await createQueueForBatch(batchId, attempt.id)) ?? [];
    assert.ok(queueRow);
    await claimForSubmission(queueRow.id);

    await client.query('BEGIN');
    const result = await retireApplicantWithConflictCheckWithClient(client, applicantId, 'removed', 'test: SUBMITTING conflict');
    await client.query('COMMIT');

    assert.equal(result.retired, true, 'the applicant is still retired -- a conflict is recorded, never blocked');
    assert.equal(result.conflictDetected, true);

    const { rows: queueRows } = await pool.query<{ status: string; conflict_detected_at: string | null }>(
      'SELECT status, conflict_detected_at FROM visa_submission_queue WHERE id = $1',
      [queueRow.id],
    );
    assert.equal(queueRows[0]?.status, 'SUBMITTING', 'an in-flight submission must never be reset or auto-resubmitted');
    assert.ok(queueRows[0]?.conflict_detected_at, 'conflict_detected_at must be set once the conflict is found');

    const { rows: alertRows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM visa_operator_alerts WHERE visa_submission_queue_id = $1 AND alert_type = 'conflict'`,
      [queueRow.id],
    );
    assert.equal(alertRows[0]?.count, '1', 'exactly one durable conflict alert must be recorded');
  } finally {
    client.release();
    await cleanupAll([groupId]);
  }
});

test('retireApplicantWithConflictCheckWithClient holds the applicant lock first: a concurrent claim genuinely blocks on it, then loses, using two REAL separate PostgreSQL connections', async () => {
  const groupId = await createGroup();
  const clientA = await pool.connect();
  let clientAInTransaction = false;
  let claimPromise: ReturnType<typeof atomicTransition> | undefined;
  try {
    const { applicantId, batchId } = await createActiveApplicant(groupId);
    const attempt = await createSubmissionAttempt(batchId, 'operator:test');
    const [queueRow] = (await createQueueForBatch(batchId, attempt.id)) ?? [];
    assert.ok(queueRow);

    await clientA.query('BEGIN');
    clientAInTransaction = true;
    const retireResult = await retireApplicantWithConflictCheckWithClient(clientA, applicantId, 'removed', 'race test: retirement first');
    assert.equal(retireResult.retired, true);
    // clientA's transaction is still open (not yet committed) -- it still
    // holds the FOR UPDATE locks retireApplicantWithConflictCheckWithClient
    // itself took on both the applicant and queue rows.

    const {
      rows: [backend],
    } = await clientA.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    assert.ok(backend);
    const clientAPid = backend.pid;

    claimPromise = atomicTransition(queueRow.id, 'PENDING', 'SUBMITTING');

    const wasBlocked = await isBlockedBy(clientAPid, 5000);
    assert.equal(
      wasBlocked,
      true,
      'could not confirm via pg_blocking_pids that the claim was genuinely blocked by clientA\'s held applicant lock -- ' +
        'this test does NOT demonstrate the ordering guarantee without that confirmation',
    );

    await clientA.query('COMMIT');
    clientAInTransaction = false;

    const claimResult = await claimPromise;
    claimPromise = undefined;
    assert.notEqual(
      claimResult.outcome,
      'transitioned',
      'a claim that was blocked behind an in-flight retirement must never win once that retirement commits',
    );

    const { rows: queueRows } = await pool.query<{ status: string }>('SELECT status FROM visa_submission_queue WHERE id = $1', [
      queueRow.id,
    ]);
    assert.equal(queueRows[0]?.status, 'PENDING', 'the rejected claim must leave the queue row exactly where retirement left it');
  } finally {
    if (clientAInTransaction) {
      await clientA.query('ROLLBACK').catch(() => {});
    }
    if (claimPromise) {
      await claimPromise.catch(() => {});
    }
    clientA.release();
    await cleanupAll([groupId]);
  }
});

test('claim holds the applicant lock first: a concurrent retireApplicantWithConflictCheckWithClient genuinely blocks on it, then correctly detects the conflict once claim commits', async () => {
  async function retireViaOwnConnection(applicantId: string) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await retireApplicantWithConflictCheckWithClient(client, applicantId, 'removed', 'race test: claim first');
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  const groupId = await createGroup();
  const clientA = await pool.connect();
  let clientAInTransaction = false;
  let retirePromise: ReturnType<typeof retireViaOwnConnection> | undefined;
  try {
    const { applicantId, batchId } = await createActiveApplicant(groupId);
    const attempt = await createSubmissionAttempt(batchId, 'operator:test');
    const [queueRow] = (await createQueueForBatch(batchId, attempt.id)) ?? [];
    assert.ok(queueRow);

    await clientA.query('BEGIN');
    clientAInTransaction = true;
    await clientA.query('SELECT status FROM visa_batch_applicants WHERE id = $1 FOR SHARE', [applicantId]);
    const { rows: claimedRows } = await clientA.query<{ status: string }>(
      `UPDATE visa_submission_queue SET status = 'SUBMITTING', claimed_at = now(), attempts = attempts + 1
       WHERE id = $1 AND status = 'PENDING' RETURNING status`,
      [queueRow.id],
    );
    assert.equal(claimedRows[0]?.status, 'SUBMITTING');

    const {
      rows: [backend],
    } = await clientA.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    assert.ok(backend);
    const clientAPid = backend.pid;

    retirePromise = retireViaOwnConnection(applicantId);

    const wasBlocked = await isBlockedBy(clientAPid, 5000);
    assert.equal(
      wasBlocked,
      true,
      'could not confirm via pg_blocking_pids that the retirement was genuinely blocked by the claim-equivalent FOR SHARE lock',
    );

    await clientA.query('COMMIT');
    clientAInTransaction = false;

    const retireResult = await retirePromise;
    retirePromise = undefined;
    assert.equal(retireResult.retired, true);
    assert.equal(
      retireResult.conflictDetected,
      true,
      'retirement must detect the conflict once it sees the now-committed SUBMITTING queue row',
    );

    const { rows: queueRows } = await pool.query<{ status: string; conflict_detected_at: string | null }>(
      'SELECT status, conflict_detected_at FROM visa_submission_queue WHERE id = $1',
      [queueRow.id],
    );
    assert.equal(queueRows[0]?.status, 'SUBMITTING', 'retirement must never reset an in-flight submission back to PENDING');
    assert.ok(queueRows[0]?.conflict_detected_at);

    const { rows: alertRows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM visa_operator_alerts WHERE visa_submission_queue_id = $1 AND alert_type = 'conflict'`,
      [queueRow.id],
    );
    assert.equal(alertRows[0]?.count, '1');
  } finally {
    if (clientAInTransaction) {
      await clientA.query('ROLLBACK').catch(() => {});
    }
    if (retirePromise) {
      await retirePromise.catch(() => {});
    }
    clientA.release();
    await cleanupAll([groupId]);
  }
});

/**
 * Package 5.11, Part 2: polls pg_blocking_pids until at least minCount
 * backends are blocked TRANSITIVELY behind blockerPid -- i.e. walks the
 * chain rather than requiring every waiter to name blockerPid directly.
 *
 * Needed specifically here, not the plain waitForBlockedCount above: that
 * helper only works when the two waiters take MUTUALLY COMPATIBLE lock
 * modes with each other (e.g. two FOR SHARE requests both queuing
 * directly behind one FOR UPDATE holder, as in claim-vs-claim above).
 * flagAmbiguousForReview's own SELECT ... FOR UPDATE on the SAME queue row
 * is NOT compatible with itself, so Postgres's per-tuple lock queue is
 * FIFO: the second concurrent caller queues behind the FIRST CALLER's own
 * transaction, not directly behind clientC -- confirmed empirically via a
 * scratch diagnostic during Package 5.8's own test [22] (documented,
 * correct Postgres queueing behavior, not a bug). This helper walks that
 * chain instead of assuming every waiter reports blockerPid directly.
 */
async function waitForTransitivelyBlockedCount(blockerPid: number, minCount: number, timeoutMs: number): Promise<Set<number>> {
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

test('Package 5.11: flagAmbiguousForReview -- two TRULY CONCURRENT calls for the SAME queueId converge to exactly one review row and one alert, using two deterministically-confirmed separate PostgreSQL connections', async () => {
  // Part 2 of Package 5.11: flagAmbiguousForReview's own doc comment
  // already discloses its check-then-insert idempotency is
  // application-level, not DB-constraint-backed for the review row (only
  // the alert insert has a UNIQUE-constraint backstop) -- Package 5.10's
  // audit flagged this as NOT VERIFIED under true concurrency, only ever
  // tested sequentially (via visaCheckAmbiguousCommand's own idempotency
  // test). A bare Promise.all is not sufficient proof on its own (the race
  // could resolve in under 5ms and simply never overlap) -- a third
  // connection (clientC) holds the SAME queue row's lock open
  // indefinitely, forcing both concurrent calls to queue up behind it
  // deterministically, confirmed via pg_blocking_pids (walked
  // transitively -- see waitForTransitivelyBlockedCount's own doc comment
  // for why the plain, direct-blocker helper above does not apply here).
  const groupId = await createGroup();
  const clientC = await pool.connect();
  let clientCInTransaction = false;
  let flagPromiseA: ReturnType<typeof flagAmbiguousForReview> | undefined;
  let flagPromiseB: ReturnType<typeof flagAmbiguousForReview> | undefined;
  try {
    const { batchId } = await createActiveApplicant(groupId);
    const attempt = await createSubmissionAttempt(batchId, 'operator:test');
    const [queueRow] = (await createQueueForBatch(batchId, attempt.id)) ?? [];
    assert.ok(queueRow);
    await claimForSubmission(queueRow.id);
    await finalizeSubmission(queueRow.id, 'AMBIGUOUS');

    await clientC.query('BEGIN');
    clientCInTransaction = true;
    await clientC.query('SELECT id FROM visa_submission_queue WHERE id = $1 FOR UPDATE', [queueRow.id]);
    const {
      rows: [backend],
    } = await clientC.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    assert.ok(backend);
    const clientCPid = backend.pid;

    flagPromiseA = flagAmbiguousForReview(queueRow.id, 'operator A requested a portal check');
    flagPromiseB = flagAmbiguousForReview(queueRow.id, 'operator B requested a portal check');

    const blockedPids = await waitForTransitivelyBlockedCount(clientCPid, 2, 5000);
    assert.equal(
      blockedPids.size,
      2,
      `expected BOTH concurrent flagAmbiguousForReview calls to be genuinely blocked behind clientC's held lock -- observed ${blockedPids.size}; ` +
        'without this confirmation the test cannot be trusted as a real concurrency proof',
    );

    await clientC.query('COMMIT');
    clientCInTransaction = false;

    const [resultA, resultB] = await Promise.all([flagPromiseA, flagPromiseB]);
    flagPromiseA = undefined;
    flagPromiseB = undefined;

    const outcomes = [resultA, resultB].sort();
    assert.deepEqual(outcomes, ['already-flagged', 'flagged'], 'exactly one of the two truly concurrent calls must flag; the other must see it already done');

    const { rows: reviewRows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM visa_submission_reviews WHERE visa_submission_queue_id = $1`,
      [queueRow.id],
    );
    assert.equal(reviewRows[0]?.count, '1', 'never a second review row, even under genuine concurrency');

    const { rows: alertRows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM visa_operator_alerts WHERE visa_submission_queue_id = $1 AND alert_type = 'ambiguous_submission'`,
      [queueRow.id],
    );
    assert.equal(alertRows[0]?.count, '1', 'never a second alert, even under genuine concurrency');
  } finally {
    if (clientCInTransaction) {
      await clientC.query('ROLLBACK').catch(() => {});
    }
    if (flagPromiseA) {
      await flagPromiseA.catch(() => {});
    }
    if (flagPromiseB) {
      await flagPromiseB.catch(() => {});
    }
    clientC.release();
    await cleanupAll([groupId]);
  }
});

test('Package 5.12: countPendingWithInactiveApplicantForBatch counts only a PENDING row whose applicant is inactive, never a live PENDING row, and never another batch\'s rows', async () => {
  const groupA = await createGroup();
  const groupB = await createGroup();
  try {
    const { applicantId: inactiveApplicantId, batchId } = await createActiveApplicant(groupA);
    const { batchId: sameBatchId } = await createActiveApplicant(groupA);
    assert.equal(sameBatchId, batchId, 'both applicants in groupA share the same batch, per assignVisaBatch\'s own batching rule');

    const attempt = await createSubmissionAttempt(batchId, 'operator:test');
    const created = await createQueueForBatch(batchId, attempt.id);
    assert.ok(created && created.length === 2);

    // Retire ONE applicant via the real production path (cancelWithConflictCheck,
    // the same one /visa_stop_applicant uses) while its queue row is still
    // PENDING, never touched by retirement -- exactly Package 5.10's audit
    // finding 5 scenario. The other applicant stays active with its own
    // PENDING row, in the SAME batch.
    const cancelResult = await cancelWithConflictCheck(inactiveApplicantId, 'cancelled');
    assert.equal(cancelResult.cancelled, true);
    assert.equal(cancelResult.conflictDetected, false, 'a PENDING row is never a conflict');

    const { rows: queueStatuses } = await pool.query<{ status: string }>(
      'SELECT status FROM visa_submission_queue WHERE batch_id = $1',
      [batchId],
    );
    assert.ok(
      queueStatuses.every((row) => row.status === 'PENDING'),
      'retirement must never touch either queue row\'s status',
    );

    const countForBatch = await countPendingWithInactiveApplicantForBatch(batchId);
    assert.equal(countForBatch, 1, 'exactly the one retired applicant\'s PENDING row must be counted -- the other, still-active one must not');

    // A second batch (groupB), with its OWN inactive applicant's PENDING
    // row, must never leak into groupA's count.
    const { applicantId: otherInactiveApplicantId, batchId: otherBatchId } = await createActiveApplicant(groupB);
    const otherAttempt = await createSubmissionAttempt(otherBatchId, 'operator:test');
    const otherCreated = await createQueueForBatch(otherBatchId, otherAttempt.id);
    assert.ok(otherCreated && otherCreated.length === 1);
    await cancelWithConflictCheck(otherInactiveApplicantId, 'cancelled');

    const countForOtherBatch = await countPendingWithInactiveApplicantForBatch(otherBatchId);
    assert.equal(countForOtherBatch, 1, 'the other batch\'s own inactive-applicant PENDING row must be counted for ITSELF');

    const countForBatchAgain = await countPendingWithInactiveApplicantForBatch(batchId);
    assert.equal(countForBatchAgain, 1, 'groupA\'s own count must be completely unaffected by groupB\'s rows -- never summed across batches');
  } finally {
    await cleanupAll([groupA, groupB]);
  }
});
