import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pool } from '../src/db/pool.js';
import { assignVisaBatch } from '../src/visa/assignVisaBatch.js';
import { createPassportIdentity } from '../src/db/repositories/passportIdentity.repo.js';
import { claimForSubmission, createQueueForBatch, createSubmissionAttempt, finalizeSubmission } from '../src/db/repositories/visaSubmissionQueue.repo.js';
import { visaCheckAmbiguousCommand } from '../src/visa/visaCheckAmbiguousCommand.js';

let idCounter = 0;
function uniqueChatId(): number {
  idCounter += 1;
  return -1 * (Date.now() * 1000 + idCounter);
}
function uniquePassportNumber(): string {
  idCounter += 1;
  return `CHECKAMBIGTEST${Date.now()}${idCounter}`;
}

const DEPARTURE_DATE = '2026-12-22';

async function createGroup(): Promise<{ groupId: string; chatId: number }> {
  const chatId = uniqueChatId();
  const {
    rows: [group],
  } = await pool.query<{ id: string }>(
    `INSERT INTO groups (name, departure_date, telegram_chat_id) VALUES ($1, $2, $3) RETURNING id`,
    ['Check Ambiguous Command Test Group', DEPARTURE_DATE, chatId],
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

async function queueAndMoveToAmbiguous(groupId: string): Promise<{ applicantId: string; queueId: string }> {
  const { applicantId, batchId } = await createActiveApplicant(groupId);
  const attempt = await createSubmissionAttempt(batchId, 'operator:test');
  const created = await createQueueForBatch(batchId, attempt.id);
  assert.ok(created && created[0]);
  await claimForSubmission(created[0].id);
  await finalizeSubmission(created[0].id, 'AMBIGUOUS');
  return { applicantId, queueId: created[0].id };
}

test('visaCheckAmbiguousCommand: an unauthorized operator is rejected, nothing is written', async () => {
  const { groupId, chatId } = await createGroup();
  try {
    const { applicantId } = await queueAndMoveToAmbiguous(groupId);

    const outcome = await visaCheckAmbiguousCommand({ telegramChatId: chatId, authorStatus: 'member', visaBatchApplicantId: applicantId });
    assert.deepEqual(outcome, { kind: 'UNAUTHORIZED' });

    const { rows } = await pool.query('SELECT id FROM visa_submission_reviews');
    assert.equal(rows.length, 0);
  } finally {
    await cleanupAll([groupId]);
  }
});

test("visaCheckAmbiguousCommand: an operator cannot check another group's applicant", async () => {
  const groupA = await createGroup();
  const groupB = await createGroup();
  try {
    const { applicantId } = await queueAndMoveToAmbiguous(groupA.groupId);

    const outcome = await visaCheckAmbiguousCommand({
      telegramChatId: groupB.chatId,
      authorStatus: 'administrator',
      visaBatchApplicantId: applicantId,
    });
    assert.deepEqual(outcome, { kind: 'APPLICANT_NOT_FOUND' });
  } finally {
    await cleanupAll([groupA.groupId, groupB.groupId]);
  }
});

test('visaCheckAmbiguousCommand: NOT_AMBIGUOUS for a PENDING queue item -- never flags a non-ambiguous row', async () => {
  const { groupId, chatId } = await createGroup();
  try {
    const { applicantId, batchId } = await createActiveApplicant(groupId);
    const attempt = await createSubmissionAttempt(batchId, 'operator:test');
    await createQueueForBatch(batchId, attempt.id);

    const outcome = await visaCheckAmbiguousCommand({ telegramChatId: chatId, authorStatus: 'creator', visaBatchApplicantId: applicantId });
    assert.deepEqual(outcome, { kind: 'NOT_AMBIGUOUS' });

    const { rows } = await pool.query('SELECT id FROM visa_submission_reviews');
    assert.equal(rows.length, 0);
  } finally {
    await cleanupAll([groupId]);
  }
});

test('visaCheckAmbiguousCommand: flags a genuinely AMBIGUOUS item for review, recording both a review row and a durable alert', async () => {
  const { groupId, chatId } = await createGroup();
  try {
    const { applicantId, queueId } = await queueAndMoveToAmbiguous(groupId);

    const outcome = await visaCheckAmbiguousCommand({ telegramChatId: chatId, authorStatus: 'creator', visaBatchApplicantId: applicantId });
    assert.deepEqual(outcome, { kind: 'FLAGGED_FOR_REVIEW' });

    const { rows: reviewRows } = await pool.query<{ status: string }>('SELECT status FROM visa_submission_reviews WHERE visa_submission_queue_id = $1', [
      queueId,
    ]);
    assert.equal(reviewRows.length, 1);
    assert.equal(reviewRows[0]?.status, 'pending');

    const { rows: alertRows } = await pool.query(`SELECT id FROM visa_operator_alerts WHERE visa_submission_queue_id = $1 AND alert_type = 'ambiguous_submission'`, [
      queueId,
    ]);
    assert.equal(alertRows.length, 1);

    const { rows: queueRows } = await pool.query<{ status: string }>('SELECT status FROM visa_submission_queue WHERE id = $1', [queueId]);
    assert.equal(queueRows[0]?.status, 'AMBIGUOUS', 'flagging for review must never change the queue status itself');
  } finally {
    await cleanupAll([groupId]);
  }
});

test('visaCheckAmbiguousCommand: a repeated check is idempotent -- ALREADY_FLAGGED, never a second review row or a second alert', async () => {
  const { groupId, chatId } = await createGroup();
  try {
    const { applicantId, queueId } = await queueAndMoveToAmbiguous(groupId);

    const first = await visaCheckAmbiguousCommand({ telegramChatId: chatId, authorStatus: 'creator', visaBatchApplicantId: applicantId });
    assert.deepEqual(first, { kind: 'FLAGGED_FOR_REVIEW' });

    const second = await visaCheckAmbiguousCommand({ telegramChatId: chatId, authorStatus: 'administrator', visaBatchApplicantId: applicantId });
    assert.deepEqual(second, { kind: 'ALREADY_FLAGGED' });

    const { rows: reviewRows } = await pool.query('SELECT id FROM visa_submission_reviews WHERE visa_submission_queue_id = $1', [queueId]);
    assert.equal(reviewRows.length, 1, 'never a second review row');

    const { rows: alertRows } = await pool.query(`SELECT id FROM visa_operator_alerts WHERE visa_submission_queue_id = $1 AND alert_type = 'ambiguous_submission'`, [
      queueId,
    ]);
    assert.equal(alertRows.length, 1, 'never a second alert');
  } finally {
    await cleanupAll([groupId]);
  }
});

test('visaCheckAmbiguousCommand: NO_QUEUE_RECORD when the applicant was never queued at all', async () => {
  const { groupId, chatId } = await createGroup();
  try {
    const { applicantId } = await createActiveApplicant(groupId);

    const outcome = await visaCheckAmbiguousCommand({ telegramChatId: chatId, authorStatus: 'creator', visaBatchApplicantId: applicantId });
    assert.deepEqual(outcome, { kind: 'NO_QUEUE_RECORD' });
  } finally {
    await cleanupAll([groupId]);
  }
});
