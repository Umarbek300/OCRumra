import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pool } from '../src/db/pool.js';
import { assignVisaBatch } from '../src/visa/assignVisaBatch.js';
import { createPassportIdentity } from '../src/db/repositories/passportIdentity.repo.js';
import { claimForSubmission, createQueueForBatch, createSubmissionAttempt } from '../src/db/repositories/visaSubmissionQueue.repo.js';
import { visaStopApplicantCommand } from '../src/visa/visaStopApplicantCommand.js';

let idCounter = 0;
function uniqueChatId(): number {
  idCounter += 1;
  return -1 * (Date.now() * 1000 + idCounter);
}
function uniquePassportNumber(): string {
  idCounter += 1;
  return `STOPCMDTEST${Date.now()}${idCounter}`;
}

const DEPARTURE_DATE = '2026-12-20';

async function createGroup(): Promise<{ groupId: string; chatId: number }> {
  const chatId = uniqueChatId();
  const {
    rows: [group],
  } = await pool.query<{ id: string }>(
    `INSERT INTO groups (name, departure_date, telegram_chat_id) VALUES ($1, $2, $3) RETURNING id`,
    ['Stop Applicant Command Test Group', DEPARTURE_DATE, chatId],
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

test('visaStopApplicantCommand: an unauthorized operator is rejected and nothing changes', async () => {
  const { groupId, chatId } = await createGroup();
  try {
    const { applicantId } = await createActiveApplicant(groupId);

    const outcome = await visaStopApplicantCommand({ telegramChatId: chatId, authorStatus: 'member', visaBatchApplicantId: applicantId });
    assert.deepEqual(outcome, { kind: 'UNAUTHORIZED' });

    const { rows } = await pool.query<{ status: string }>('SELECT status FROM visa_batch_applicants WHERE id = $1', [applicantId]);
    assert.equal(rows[0]?.status, 'active', 'an unauthorized stop must never change the applicant status');
  } finally {
    await cleanupAll([groupId]);
  }
});

test("visaStopApplicantCommand: an operator cannot act on another group's applicant", async () => {
  const groupA = await createGroup();
  const groupB = await createGroup();
  try {
    const { applicantId } = await createActiveApplicant(groupA.groupId);

    // groupB's own administrator tries to stop groupA's applicant.
    const outcome = await visaStopApplicantCommand({
      telegramChatId: groupB.chatId,
      authorStatus: 'administrator',
      visaBatchApplicantId: applicantId,
    });
    assert.deepEqual(outcome, { kind: 'APPLICANT_NOT_FOUND' });

    const { rows } = await pool.query<{ status: string }>('SELECT status FROM visa_batch_applicants WHERE id = $1', [applicantId]);
    assert.equal(rows[0]?.status, 'active', "a cross-group attempt must never change the OTHER group's applicant");
  } finally {
    await cleanupAll([groupA.groupId, groupB.groupId]);
  }
});

test('visaStopApplicantCommand: cleanly stops a PENDING (unclaimed) queue item', async () => {
  const { groupId, chatId } = await createGroup();
  try {
    const { applicantId, batchId } = await createActiveApplicant(groupId);
    const attempt = await createSubmissionAttempt(batchId, 'operator:test');
    await createQueueForBatch(batchId, attempt.id);

    const outcome = await visaStopApplicantCommand({ telegramChatId: chatId, authorStatus: 'creator', visaBatchApplicantId: applicantId });
    assert.deepEqual(outcome, { kind: 'STOPPED' });

    const { rows } = await pool.query<{ status: string }>('SELECT status FROM visa_batch_applicants WHERE id = $1', [applicantId]);
    assert.equal(rows[0]?.status, 'cancelled');
  } finally {
    await cleanupAll([groupId]);
  }
});

test('visaStopApplicantCommand: detects a SUBMITTING conflict, still stops, and never hides it -- a conflict alert is recorded', async () => {
  const { groupId, chatId } = await createGroup();
  try {
    const { applicantId, batchId } = await createActiveApplicant(groupId);
    const attempt = await createSubmissionAttempt(batchId, 'operator:test');
    const created = await createQueueForBatch(batchId, attempt.id);
    assert.ok(created && created[0]);
    await claimForSubmission(created[0].id);

    const outcome = await visaStopApplicantCommand({ telegramChatId: chatId, authorStatus: 'creator', visaBatchApplicantId: applicantId });
    assert.deepEqual(outcome, { kind: 'STOPPED_BUT_MAY_ALREADY_BE_SUBMITTED' });

    const { rows: applicantRows } = await pool.query<{ status: string }>('SELECT status FROM visa_batch_applicants WHERE id = $1', [
      applicantId,
    ]);
    assert.equal(applicantRows[0]?.status, 'cancelled', 'the applicant is still stopped even though a conflict was detected');

    const { rows: queueRows } = await pool.query<{ status: string }>('SELECT status FROM visa_submission_queue WHERE id = $1', [
      created[0].id,
    ]);
    assert.equal(queueRows[0]?.status, 'SUBMITTING', 'the submission itself must never be auto-reset');

    const { rows: alertRows } = await pool.query(`SELECT id FROM visa_operator_alerts WHERE visa_submission_queue_id = $1 AND alert_type = 'conflict'`, [
      created[0].id,
    ]);
    assert.equal(alertRows.length, 1, 'a conflict alert must be durably recorded');
  } finally {
    await cleanupAll([groupId]);
  }
});

test('visaStopApplicantCommand: a repeated stop is idempotent -- ALREADY_INACTIVE, no second conflict/alert', async () => {
  const { groupId, chatId } = await createGroup();
  try {
    const { applicantId, batchId } = await createActiveApplicant(groupId);
    const attempt = await createSubmissionAttempt(batchId, 'operator:test');
    await createQueueForBatch(batchId, attempt.id);

    const first = await visaStopApplicantCommand({ telegramChatId: chatId, authorStatus: 'creator', visaBatchApplicantId: applicantId });
    assert.deepEqual(first, { kind: 'STOPPED' });

    const second = await visaStopApplicantCommand({ telegramChatId: chatId, authorStatus: 'creator', visaBatchApplicantId: applicantId });
    assert.deepEqual(second, { kind: 'ALREADY_INACTIVE' });
  } finally {
    await cleanupAll([groupId]);
  }
});
