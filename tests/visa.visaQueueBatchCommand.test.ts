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
import { visaQueueBatchCommand } from '../src/visa/visaQueueBatchCommand.js';

let idCounter = 0;
function uniqueChatId(): number {
  idCounter += 1;
  return -1 * (Date.now() * 1000 + idCounter);
}
function uniquePassportNumber(): string {
  idCounter += 1;
  return `QUEUEBATCHCMDTEST${Date.now()}${idCounter}`;
}

const DEPARTURE_DATE = '2026-12-15';

async function createGroup(): Promise<{ groupId: string; chatId: number }> {
  const chatId = uniqueChatId();
  const {
    rows: [group],
  } = await pool.query<{ id: string }>(
    `INSERT INTO groups (name, departure_date, telegram_chat_id) VALUES ($1, $2, $3) RETURNING id`,
    ['Queue Batch Command Test Group', DEPARTURE_DATE, chatId],
  );
  assert.ok(group);
  return { groupId: group.id, chatId };
}

async function createActiveApplicant(groupId: string): Promise<{ applicantId: string; batchId: string }> {
  const identity = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
  assert.ok(identity);
  const assignment = await assignVisaBatch(groupId, identity.id, 'visitsaudi', DEPARTURE_DATE);
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

test('visaQueueBatchCommand: administrator successfully queues a batch', async () => {
  const { groupId, chatId } = await createGroup();
  try {
    const a = await createActiveApplicant(groupId);
    const b = await createActiveApplicant(groupId);

    const outcome = await visaQueueBatchCommand({ telegramChatId: chatId, authorStatus: 'administrator', requestedBy: 'operator:admin' });
    assert.equal(outcome.kind, 'QUEUED');
    if (outcome.kind !== 'QUEUED') throw new Error('unreachable');
    assert.equal(outcome.queuedCount, 2);

    const { rows } = await pool.query<{ status: string }>('SELECT status FROM visa_submission_queue WHERE batch_id = $1', [a.batchId]);
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.status === 'PENDING'), 'queuing must never claim/submit -- every row stays PENDING');
    void b;
  } finally {
    await cleanupAll([groupId]);
  }
});

test('visaQueueBatchCommand: a plain member is rejected, and nothing is created', async () => {
  const { groupId, chatId } = await createGroup();
  try {
    await createActiveApplicant(groupId);

    const outcome = await visaQueueBatchCommand({ telegramChatId: chatId, authorStatus: 'member', requestedBy: 'operator:member' });
    assert.deepEqual(outcome, { kind: 'UNAUTHORIZED' });

    const { rows } = await pool.query('SELECT id FROM visa_submission_attempts WHERE batch_id IN (SELECT id FROM visa_batches WHERE group_id = $1)', [
      groupId,
    ]);
    assert.equal(rows.length, 0, 'an unauthorized call must never create a submission attempt');
  } finally {
    await cleanupAll([groupId]);
  }
});

test('visaQueueBatchCommand: NO_BATCH when the group has never had a VisitSaudi batch', async () => {
  const { groupId, chatId } = await createGroup();
  try {
    const outcome = await visaQueueBatchCommand({ telegramChatId: chatId, authorStatus: 'creator', requestedBy: 'operator:test' });
    assert.deepEqual(outcome, { kind: 'NO_BATCH' });
  } finally {
    await cleanupAll([groupId]);
  }
});

test('visaQueueBatchCommand: EMPTY_BATCH when the only batch has no active applicants left', async () => {
  const { groupId, chatId } = await createGroup();
  try {
    const { applicantId } = await createActiveApplicant(groupId);
    await pool.query(`UPDATE visa_batch_applicants SET status = 'cancelled' WHERE id = $1`, [applicantId]);

    const outcome = await visaQueueBatchCommand({ telegramChatId: chatId, authorStatus: 'creator', requestedBy: 'operator:test' });
    assert.equal(outcome.kind, 'EMPTY_BATCH');

    const { rows } = await pool.query('SELECT id FROM visa_submission_attempts WHERE batch_id IN (SELECT id FROM visa_batches WHERE group_id = $1)', [
      groupId,
    ]);
    assert.equal(rows.length, 0, 'an empty batch must never create a submission attempt either');
  } finally {
    await cleanupAll([groupId]);
  }
});

test('visaQueueBatchCommand: a repeated command never creates a duplicate attempt or duplicate queue rows', async () => {
  const { groupId, chatId } = await createGroup();
  try {
    await createActiveApplicant(groupId);

    const first = await visaQueueBatchCommand({ telegramChatId: chatId, authorStatus: 'administrator', requestedBy: 'operator:a' });
    assert.equal(first.kind, 'QUEUED');

    const second = await visaQueueBatchCommand({ telegramChatId: chatId, authorStatus: 'administrator', requestedBy: 'operator:b' });
    assert.equal(second.kind, 'ALREADY_QUEUED');

    const { rows: attempts } = await pool.query(
      'SELECT id FROM visa_submission_attempts WHERE batch_id IN (SELECT id FROM visa_batches WHERE group_id = $1)',
      [groupId],
    );
    assert.equal(attempts.length, 1, 'never a second submission attempt');

    const { rows: queued } = await pool.query('SELECT id FROM visa_submission_queue WHERE group_id = $1', [groupId]);
    assert.equal(queued.length, 1, 'never a duplicate queue row');
  } finally {
    await cleanupAll([groupId]);
  }
});

test('visaQueueBatchCommand: two PARALLEL calls for the same batch never create two attempts, two queue-row sets, or an unhandled error', async () => {
  const { groupId, chatId } = await createGroup();
  try {
    await createActiveApplicant(groupId);
    await createActiveApplicant(groupId);

    const [a, b] = await Promise.all([
      visaQueueBatchCommand({ telegramChatId: chatId, authorStatus: 'administrator', requestedBy: 'operator:a' }),
      visaQueueBatchCommand({ telegramChatId: chatId, authorStatus: 'administrator', requestedBy: 'operator:b' }),
    ]);

    const outcomes = [a.kind, b.kind].sort();
    assert.deepEqual(outcomes, ['ALREADY_QUEUED', 'QUEUED'], 'exactly one caller queues, the other observes ALREADY_QUEUED -- neither throws');

    const { rows: attempts } = await pool.query(
      'SELECT id FROM visa_submission_attempts WHERE batch_id IN (SELECT id FROM visa_batches WHERE group_id = $1)',
      [groupId],
    );
    assert.equal(attempts.length, 1, 'a double-click/parallel request must never create a second submission attempt');

    const { rows: queued } = await pool.query('SELECT id FROM visa_submission_queue WHERE group_id = $1', [groupId]);
    assert.equal(queued.length, 2, 'exactly 2 queue rows (one per active applicant), never 4');
  } finally {
    await cleanupAll([groupId]);
  }
});

test('a batch never holds more than 10 active applicants, and queuing the full batch queues exactly 10', async () => {
  const { groupId, chatId } = await createGroup();
  try {
    let fullBatchId = '';
    for (let i = 0; i < 10; i += 1) {
      const { batchId } = await createActiveApplicant(groupId);
      fullBatchId = batchId;
    }
    const overflow = await createActiveApplicant(groupId);
    assert.notEqual(overflow.batchId, fullBatchId, "the 11th applicant must open a NEW batch -- assignVisaBatch's own existing cap, not re-implemented here");

    const attempt = await createSubmissionAttempt(fullBatchId, 'operator:test');
    const created = await createQueueForBatch(fullBatchId, attempt.id);
    assert.ok(created);
    assert.equal(created.length, 10, 'queuing a full batch must queue exactly 10, never more');

    // The command itself always targets the MOST RECENT batch (the
    // 1-applicant overflow batch here) -- confirm it does NOT touch the
    // already-queued, full batch.
    const outcome = await visaQueueBatchCommand({ telegramChatId: chatId, authorStatus: 'creator', requestedBy: 'operator:test' });
    assert.equal(outcome.kind, 'QUEUED');
    if (outcome.kind !== 'QUEUED') throw new Error('unreachable');
    assert.equal(outcome.queuedCount, 1, 'the command targets the overflow batch, not the already-queued full one');
  } finally {
    await cleanupAll([groupId]);
  }
});

test('visaQueueBatchCommand never re-queues a batch whose rows have already moved to a risky state (SUBMITTING/AMBIGUOUS), and never resets them', async () => {
  const { groupId, chatId } = await createGroup();
  try {
    await createActiveApplicant(groupId);

    const first = await visaQueueBatchCommand({ telegramChatId: chatId, authorStatus: 'administrator', requestedBy: 'operator:a' });
    assert.equal(first.kind, 'QUEUED');

    const { rows } = await pool.query<{ id: string }>('SELECT id FROM visa_submission_queue WHERE group_id = $1', [groupId]);
    const queueId = rows[0]!.id;
    await claimForSubmission(queueId);
    await finalizeSubmission(queueId, 'AMBIGUOUS');

    const second = await visaQueueBatchCommand({ telegramChatId: chatId, authorStatus: 'administrator', requestedBy: 'operator:b' });
    assert.equal(second.kind, 'ALREADY_QUEUED');

    const { rows: statusRows } = await pool.query<{ status: string }>('SELECT status FROM visa_submission_queue WHERE id = $1', [queueId]);
    assert.equal(statusRows[0]?.status, 'AMBIGUOUS', 'a second queue command must never touch/reset an existing AMBIGUOUS row');
  } finally {
    await cleanupAll([groupId]);
  }
});

test('visaQueueBatchCommand never touches an in-flight SUBMITTING row that also carries a cancellation conflict', async () => {
  const { groupId, chatId } = await createGroup();
  try {
    const applicant = await createActiveApplicant(groupId);
    // A second, untouched applicant stays active so the batch is NOT
    // empty after the first one is cancelled below -- isolating exactly
    // the "already queued, don't touch the conflicted row" behavior,
    // rather than the (also correct, but different) EMPTY_BATCH outcome.
    await createActiveApplicant(groupId);

    const first = await visaQueueBatchCommand({ telegramChatId: chatId, authorStatus: 'administrator', requestedBy: 'operator:a' });
    assert.equal(first.kind, 'QUEUED');

    const { rows } = await pool.query<{ id: string }>('SELECT id FROM visa_submission_queue WHERE group_id = $1', [groupId]);
    const queueId = rows[0]!.id;
    await claimForSubmission(queueId);
    const cancelResult = await cancelWithConflictCheck(applicant.applicantId, 'cancelled');
    assert.equal(cancelResult.conflictDetected, true);

    const second = await visaQueueBatchCommand({ telegramChatId: chatId, authorStatus: 'administrator', requestedBy: 'operator:b' });
    assert.equal(second.kind, 'ALREADY_QUEUED');

    const { rows: statusRows } = await pool.query<{ status: string }>('SELECT status FROM visa_submission_queue WHERE id = $1', [queueId]);
    assert.equal(statusRows[0]?.status, 'SUBMITTING', 'queuing must never reset a conflicted SUBMITTING row back to PENDING');
  } finally {
    await cleanupAll([groupId]);
  }
});
