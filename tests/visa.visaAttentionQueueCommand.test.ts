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
import { visaAttentionQueueCommand } from '../src/visa/visaAttentionQueueCommand.js';

let idCounter = 0;
function uniqueChatId(): number {
  idCounter += 1;
  return -1 * (Date.now() * 1000 + idCounter);
}
function uniquePassportNumber(): string {
  idCounter += 1;
  return `ATTNQUEUETEST${Date.now()}${idCounter}`;
}

const DEPARTURE_DATE = '2026-12-30';

async function createGroup(): Promise<{ groupId: string; chatId: number }> {
  const chatId = uniqueChatId();
  const {
    rows: [group],
  } = await pool.query<{ id: string }>(
    `INSERT INTO groups (name, departure_date, telegram_chat_id) VALUES ($1, $2, $3) RETURNING id`,
    ['Attention Queue Command Test Group', DEPARTURE_DATE, chatId],
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
      `DELETE FROM visa_submission_reviews WHERE visa_submission_queue_id IN (SELECT id FROM visa_submission_queue WHERE group_id = $1)`,
      [groupId],
    );
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

test('visaAttentionQueueCommand: an unauthorized operator is rejected', async () => {
  const { groupId, chatId } = await createGroup();
  try {
    const outcome = await visaAttentionQueueCommand({ telegramChatId: chatId, authorStatus: 'member' });
    assert.deepEqual(outcome, { kind: 'UNAUTHORIZED' });
  } finally {
    await cleanupAll([groupId]);
  }
});

test('visaAttentionQueueCommand: NO_BATCH when the group has never had a VisitSaudi batch', async () => {
  const { groupId, chatId } = await createGroup();
  try {
    const outcome = await visaAttentionQueueCommand({ telegramChatId: chatId, authorStatus: 'creator' });
    assert.deepEqual(outcome, { kind: 'NO_BATCH' });
  } finally {
    await cleanupAll([groupId]);
  }
});

test('visaAttentionQueueCommand: an empty attention list when nothing needs a decision (plain PENDING/SAVED excluded)', async () => {
  const { groupId, chatId } = await createGroup();
  try {
    const a = await createActiveApplicant(groupId);
    const b = await createActiveApplicant(groupId);
    const attempt = await createSubmissionAttempt(a.batchId, 'operator:test');
    const created = await createQueueForBatch(a.batchId, attempt.id);
    assert.ok(created && created.length === 2);

    // Move one to SAVED (terminal, routine) -- must NOT appear in the attention list.
    await claimForSubmission(created[0]!.id);
    await finalizeSubmission(created[0]!.id, 'SAVED');
    // The other stays PENDING -- also must not appear.

    const outcome = await visaAttentionQueueCommand({ telegramChatId: chatId, authorStatus: 'creator' });
    assert.equal(outcome.kind, 'COMPLETED');
    if (outcome.kind !== 'COMPLETED') throw new Error('unreachable');
    assert.deepEqual(outcome.items, []);
    void b;
  } finally {
    await cleanupAll([groupId]);
  }
});

test('visaAttentionQueueCommand: lists a conflicted SUBMITTING item and an AMBIGUOUS item, correctly, with group/batch names', async () => {
  const { groupId, chatId } = await createGroup();
  try {
    const conflicted = await createActiveApplicant(groupId);
    const ambiguous = await createActiveApplicant(groupId);
    const batchId = conflicted.batchId;
    assert.equal(ambiguous.batchId, batchId);

    const attempt = await createSubmissionAttempt(batchId, 'operator:test');
    const created = await createQueueForBatch(batchId, attempt.id);
    assert.ok(created && created.length === 2);

    const conflictedQueue = created.find((r) => r.visaBatchApplicantId === conflicted.applicantId);
    const ambiguousQueue = created.find((r) => r.visaBatchApplicantId === ambiguous.applicantId);
    assert.ok(conflictedQueue && ambiguousQueue);

    await claimForSubmission(conflictedQueue.id);
    const cancelResult = await cancelWithConflictCheck(conflicted.applicantId, 'cancelled');
    assert.equal(cancelResult.conflictDetected, true);

    await claimForSubmission(ambiguousQueue.id);
    await finalizeSubmission(ambiguousQueue.id, 'AMBIGUOUS');

    const outcome = await visaAttentionQueueCommand({ telegramChatId: chatId, authorStatus: 'creator' });
    assert.equal(outcome.kind, 'COMPLETED');
    if (outcome.kind !== 'COMPLETED') throw new Error('unreachable');
    assert.equal(outcome.items.length, 2);

    const statuses = outcome.items.map((i) => i.status).sort();
    assert.deepEqual(statuses, ['AMBIGUOUS', 'SUBMITTING']);
    assert.ok(outcome.groupName.length > 0);
    assert.ok(outcome.batchName.length > 0);
  } finally {
    await cleanupAll([groupId]);
  }
});

test("visaAttentionQueueCommand: never discloses another group's attention item, even when both groups have one simultaneously", async () => {
  const groupA = await createGroup();
  const groupB = await createGroup();
  try {
    const applicantA = await createActiveApplicant(groupA.groupId);
    const applicantB = await createActiveApplicant(groupB.groupId);

    const attemptA = await createSubmissionAttempt(applicantA.batchId, 'operator:test');
    const createdA = await createQueueForBatch(applicantA.batchId, attemptA.id);
    assert.ok(createdA && createdA.length === 1);
    await claimForSubmission(createdA[0]!.id);
    await finalizeSubmission(createdA[0]!.id, 'AMBIGUOUS');

    const attemptB = await createSubmissionAttempt(applicantB.batchId, 'operator:test');
    const createdB = await createQueueForBatch(applicantB.batchId, attemptB.id);
    assert.ok(createdB && createdB.length === 1);
    await claimForSubmission(createdB[0]!.id);
    await finalizeSubmission(createdB[0]!.id, 'AMBIGUOUS');

    const outcomeA = await visaAttentionQueueCommand({ telegramChatId: groupA.chatId, authorStatus: 'creator' });
    assert.equal(outcomeA.kind, 'COMPLETED');
    if (outcomeA.kind !== 'COMPLETED') throw new Error('unreachable');
    assert.equal(outcomeA.items.length, 1);
    assert.equal(outcomeA.items[0]!.visaBatchApplicantId, applicantA.applicantId);
    assert.notEqual(outcomeA.items[0]!.visaBatchApplicantId, applicantB.applicantId);

    const outcomeB = await visaAttentionQueueCommand({ telegramChatId: groupB.chatId, authorStatus: 'creator' });
    assert.equal(outcomeB.kind, 'COMPLETED');
    if (outcomeB.kind !== 'COMPLETED') throw new Error('unreachable');
    assert.equal(outcomeB.items.length, 1);
    assert.equal(outcomeB.items[0]!.visaBatchApplicantId, applicantB.applicantId);
    assert.notEqual(outcomeB.items[0]!.visaBatchApplicantId, applicantA.applicantId);
  } finally {
    await cleanupAll([groupA.groupId, groupB.groupId]);
  }
});
