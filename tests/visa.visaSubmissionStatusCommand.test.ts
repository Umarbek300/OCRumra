import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pool } from '../src/db/pool.js';
import { assignVisaBatch } from '../src/visa/assignVisaBatch.js';
import { createPassportIdentity } from '../src/db/repositories/passportIdentity.repo.js';
import {
  cancelWithConflictCheck,
  claimForSubmission,
  createQueueForBatch,
  createSubmissionAttempt,
  finalizeSubmission,
} from '../src/db/repositories/visaSubmissionQueue.repo.js';
import { visaSubmissionStatusCommand } from '../src/visa/visaSubmissionStatusCommand.js';

let idCounter = 0;
function uniqueChatId(): number {
  idCounter += 1;
  return -1 * (Date.now() * 1000 + idCounter);
}
function uniquePassportNumber(): string {
  idCounter += 1;
  return `SUBSTATUSTEST${Date.now()}${idCounter}`;
}

async function createGroup(departureDate = '2026-12-10'): Promise<{ groupId: string; chatId: number }> {
  const chatId = uniqueChatId();
  const {
    rows: [group],
  } = await pool.query<{ id: string }>(
    `INSERT INTO groups (name, departure_date, telegram_chat_id) VALUES ($1, $2, $3) RETURNING id`,
    ['Submission Status Command Test Group', departureDate, chatId],
  );
  assert.ok(group);
  return { groupId: group.id, chatId };
}

async function createActiveApplicant(groupId: string): Promise<{ applicantId: string; batchId: string }> {
  const identity = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
  assert.ok(identity);
  const assignment = await assignVisaBatch(groupId, identity.id, 'visitsaudi', '2026-12-10');
  return { applicantId: assignment.id, batchId: assignment.batchId };
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
    await pool.query(`DELETE FROM visa_batch_applicants WHERE group_id = $1`, [groupId]);
    await pool.query(`DELETE FROM visa_batches WHERE group_id = $1`, [groupId]);
    await pool.query(
      `DELETE FROM passport_identity WHERE id IN (SELECT passport_identity_id FROM visa_batch_applicants WHERE group_id = $1)`,
      [groupId],
    );
    await pool.query(`DELETE FROM groups WHERE id = $1`, [groupId]);
  }
}

test('visaSubmissionStatusCommand rejects a non-creator/administrator sender', async () => {
  const { chatId } = await createGroup();
  const outcome = await visaSubmissionStatusCommand({ telegramChatId: chatId, authorStatus: 'member' });
  assert.deepEqual(outcome, { kind: 'UNAUTHORIZED' });
});

test('visaSubmissionStatusCommand reports GROUP_NOT_FOUND for an unknown chat', async () => {
  const outcome = await visaSubmissionStatusCommand({ telegramChatId: -999999999, authorStatus: 'administrator' });
  assert.deepEqual(outcome, { kind: 'GROUP_NOT_FOUND' });
});

test('visaSubmissionStatusCommand reports NO_BATCH when the group has never had a VisitSaudi batch', async () => {
  const { groupId, chatId } = await createGroup();
  try {
    const outcome = await visaSubmissionStatusCommand({ telegramChatId: chatId, authorStatus: 'creator' });
    assert.deepEqual(outcome, { kind: 'NO_BATCH' });
  } finally {
    await cleanupAll([groupId]);
  }
});

test('visaSubmissionStatusCommand reports accurate per-status counts and the unresolved-conflict count', async () => {
  const { groupId, chatId } = await createGroup();
  try {
    const a = await createActiveApplicant(groupId);
    const b = await createActiveApplicant(groupId);
    const c = await createActiveApplicant(groupId);
    // All three share the same batch (assignVisaBatch fills one batch to
    // capacity before opening a new one) -- confirmed by reusing a.batchId.
    const batchId = a.batchId;
    assert.equal(b.batchId, batchId);
    assert.equal(c.batchId, batchId);

    const attempt = await createSubmissionAttempt(batchId, 'operator:test');
    const created = await createQueueForBatch(batchId, attempt.id);
    assert.ok(created);
    assert.equal(created.length, 3);

    const [recA, recB, recC] = created;
    assert.ok(recA && recB && recC);

    // A stays PENDING. B gets claimed (SUBMITTING) then conflicts via a
    // cancellation. C gets claimed and finalized to SAVED.
    await claimForSubmission(recB.id);
    const cancelResult = await cancelWithConflictCheck(b.applicantId, 'cancelled');
    assert.equal(cancelResult.conflictDetected, true);

    await claimForSubmission(recC.id);
    await finalizeSubmission(recC.id, 'SAVED');

    const outcome = await visaSubmissionStatusCommand({ telegramChatId: chatId, authorStatus: 'administrator' });
    assert.equal(outcome.kind, 'COMPLETED');
    if (outcome.kind !== 'COMPLETED') throw new Error('unreachable');
    assert.equal(outcome.counts.PENDING, 1);
    assert.equal(outcome.counts.SUBMITTING, 1, 'recB stays SUBMITTING -- cancelWithConflictCheck never resets it to PENDING');
    assert.equal(outcome.counts.SAVED, 1);
    assert.equal(outcome.counts.ERROR, 0);
    assert.equal(outcome.counts.AMBIGUOUS, 0);
    assert.equal(outcome.conflictCount, 1);
    assert.equal(outcome.inactivePendingCount, 0, 'Package 5.12: applicant A is still active, so its PENDING row must not be counted here');
  } finally {
    await cleanupAll([groupId]);
  }
});

test('Package 5.12: visaSubmissionStatusCommand reports inactivePendingCount without disturbing any other existing field', async () => {
  const { groupId, chatId } = await createGroup();
  try {
    const a = await createActiveApplicant(groupId);
    const b = await createActiveApplicant(groupId);
    const batchId = a.batchId;
    assert.equal(b.batchId, batchId);

    const attempt = await createSubmissionAttempt(batchId, 'operator:test');
    const created = await createQueueForBatch(batchId, attempt.id);
    assert.ok(created && created.length === 2);

    // Applicant B is retired (via the real /visa_stop_applicant path) while
    // its queue row is still PENDING -- Package 5.10's audit finding 5
    // scenario, now surfaced read-only via the new count.
    const cancelResult = await cancelWithConflictCheck(b.applicantId, 'cancelled');
    assert.equal(cancelResult.cancelled, true);
    assert.equal(cancelResult.conflictDetected, false);

    const outcome = await visaSubmissionStatusCommand({ telegramChatId: chatId, authorStatus: 'creator' });
    assert.equal(outcome.kind, 'COMPLETED');
    if (outcome.kind !== 'COMPLETED') throw new Error('unreachable');

    // Every pre-existing field keeps its own, already-tested meaning: both
    // queue rows are still PENDING (retirement never touches a PENDING
    // row), and there is still no conflict (a PENDING row is never one).
    assert.equal(outcome.counts.PENDING, 2);
    assert.equal(outcome.counts.SUBMITTING, 0);
    assert.equal(outcome.counts.SAVED, 0);
    assert.equal(outcome.counts.ERROR, 0);
    assert.equal(outcome.counts.AMBIGUOUS, 0);
    assert.equal(outcome.conflictCount, 0);
    assert.equal(outcome.inactivePendingCount, 1, 'exactly applicant B\'s row -- applicant A is still active');
  } finally {
    await cleanupAll([groupId]);
  }
});
