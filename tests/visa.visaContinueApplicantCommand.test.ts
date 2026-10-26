import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pool } from '../src/db/pool.js';
import { assignVisaBatch } from '../src/visa/assignVisaBatch.js';
import { createPassportIdentity } from '../src/db/repositories/passportIdentity.repo.js';
import { visaContinueApplicantCommand } from '../src/visa/visaContinueApplicantCommand.js';

let idCounter = 0;
function uniqueChatId(): number {
  idCounter += 1;
  return -1 * (Date.now() * 1000 + idCounter);
}
function uniquePassportNumber(): string {
  idCounter += 1;
  return `CONTINUECMDTEST${Date.now()}${idCounter}`;
}

const DEPARTURE_DATE = '2026-12-28';

async function createGroup(): Promise<{ groupId: string; chatId: number }> {
  const chatId = uniqueChatId();
  const {
    rows: [group],
  } = await pool.query<{ id: string }>(
    `INSERT INTO groups (name, departure_date, telegram_chat_id) VALUES ($1, $2, $3) RETURNING id`,
    ['Continue Applicant Command Test Group', DEPARTURE_DATE, chatId],
  );
  assert.ok(group);
  return { groupId: group.id, chatId };
}

async function createActiveApplicant(groupId: string): Promise<{ applicantId: string }> {
  const identity = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
  assert.ok(identity);
  const assignment = await assignVisaBatch(groupId, identity.id, 'visitsaudi', DEPARTURE_DATE);
  return { applicantId: assignment.id };
}

async function cleanupAll(groupIds: string[]): Promise<void> {
  for (const groupId of groupIds) {
    await pool.query(`DELETE FROM visa_batch_applicants WHERE group_id = $1`, [groupId]);
    await pool.query(`DELETE FROM visa_batches WHERE group_id = $1`, [groupId]);
    await pool.query(
      `DELETE FROM passport_identity WHERE id IN (SELECT passport_identity_id FROM visa_batch_applicants WHERE group_id = $1)`,
      [groupId],
    );
    await pool.query(`DELETE FROM groups WHERE id = $1`, [groupId]);
  }
}

test('visaContinueApplicantCommand: an unauthorized operator is rejected', async () => {
  const { groupId, chatId } = await createGroup();
  try {
    const { applicantId } = await createActiveApplicant(groupId);
    const outcome = await visaContinueApplicantCommand({ telegramChatId: chatId, authorStatus: 'member', visaBatchApplicantId: applicantId });
    assert.deepEqual(outcome, { kind: 'UNAUTHORIZED' });
  } finally {
    await cleanupAll([groupId]);
  }
});

test("visaContinueApplicantCommand: an operator cannot act on another group's applicant", async () => {
  const groupA = await createGroup();
  const groupB = await createGroup();
  try {
    const { applicantId } = await createActiveApplicant(groupA.groupId);
    const outcome = await visaContinueApplicantCommand({
      telegramChatId: groupB.chatId,
      authorStatus: 'administrator',
      visaBatchApplicantId: applicantId,
    });
    assert.deepEqual(outcome, { kind: 'APPLICANT_NOT_FOUND' });
  } finally {
    await cleanupAll([groupA.groupId, groupB.groupId]);
  }
});

test('visaContinueApplicantCommand: an unknown applicant id is rejected the same way', async () => {
  const { groupId, chatId } = await createGroup();
  try {
    const outcome = await visaContinueApplicantCommand({
      telegramChatId: chatId,
      authorStatus: 'administrator',
      visaBatchApplicantId: '00000000-0000-0000-0000-000000000000',
    });
    assert.deepEqual(outcome, { kind: 'APPLICANT_NOT_FOUND' });
  } finally {
    await cleanupAll([groupId]);
  }
});

test('visaContinueApplicantCommand: always NOT_READY for a legitimate applicant -- never starts any portal action, consistently across repeats', async () => {
  const { groupId, chatId } = await createGroup();
  try {
    const { applicantId } = await createActiveApplicant(groupId);

    const first = await visaContinueApplicantCommand({ telegramChatId: chatId, authorStatus: 'creator', visaBatchApplicantId: applicantId });
    assert.deepEqual(first, { kind: 'NOT_READY' });

    const second = await visaContinueApplicantCommand({ telegramChatId: chatId, authorStatus: 'administrator', visaBatchApplicantId: applicantId });
    assert.deepEqual(second, { kind: 'NOT_READY' }, 'repeated presses must stay safely NOT_READY, never progress toward a real submission');

    const { rows } = await pool.query<{ status: string }>('SELECT status FROM visa_batch_applicants WHERE id = $1', [applicantId]);
    assert.equal(rows[0]?.status, 'active', 'pressing DAVOM ETISH must never change the applicant itself');
  } finally {
    await cleanupAll([groupId]);
  }
});
