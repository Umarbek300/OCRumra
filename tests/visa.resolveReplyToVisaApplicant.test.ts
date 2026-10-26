import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pool } from '../src/db/pool.js';
import { assignVisaBatch } from '../src/visa/assignVisaBatch.js';
import { createPassportIdentity } from '../src/db/repositories/passportIdentity.repo.js';
import { resolveReplyToVisaApplicant } from '../src/visa/resolveReplyToVisaApplicant.js';

let idCounter = 0;
function uniqueChatId(): number {
  idCounter += 1;
  return -1 * (Date.now() * 1000 + idCounter);
}
function uniqueTelegramMessageId(): number {
  idCounter += 1;
  return idCounter;
}
function uniquePassportNumber(): string {
  idCounter += 1;
  return `RESOLVEREPLYTEST${Date.now()}${idCounter}`;
}

const DEPARTURE_DATE = '2026-12-25';

async function createGroup(): Promise<{ groupId: string; chatId: number }> {
  const chatId = uniqueChatId();
  const {
    rows: [group],
  } = await pool.query<{ id: string }>(
    `INSERT INTO groups (name, departure_date, telegram_chat_id) VALUES ($1, $2, $3) RETURNING id`,
    ['Resolve Reply Test Group', DEPARTURE_DATE, chatId],
  );
  assert.ok(group);
  return { groupId: group.id, chatId };
}

/** Creates a real telegram_messages row in this chat, mimicking the original passport photo message an operator would reply to. */
async function createPhotoMessage(groupId: string, chatId: number): Promise<{ telegramMessageUuid: string; telegramMessageId: number }> {
  const telegramMessageId = uniqueTelegramMessageId();
  const {
    rows: [message],
  } = await pool.query<{ id: string }>(
    `INSERT INTO telegram_messages (
       telegram_chat_id, telegram_message_id, telegram_sender_user_id, telegram_sender_display_name,
       message_timestamp, telegram_photo_file_id, group_id
     ) VALUES ($1,$2,$3,'Resolve Reply Test Sender', now(), 'FILE_RESOLVE_REPLY_TEST', $4)
     RETURNING id`,
    [chatId, telegramMessageId, idCounter, groupId],
  );
  assert.ok(message);
  return { telegramMessageUuid: message.id, telegramMessageId };
}

async function createActiveLink(
  telegramMessageUuid: string,
  passportIdentityId: string,
  groupId: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO passport_message_links (passport_identity_id, telegram_message_id, group_id, role, match_confidence_tier)
     VALUES ($1, $2, $3, 'canonical', 'high')`,
    [passportIdentityId, telegramMessageUuid, groupId],
  );
}

async function cleanupAll(groupIds: string[]): Promise<void> {
  for (const groupId of groupIds) {
    await pool.query(`DELETE FROM visa_submission_queue WHERE group_id = $1`, [groupId]);
    await pool.query(`DELETE FROM visa_submission_attempts WHERE batch_id IN (SELECT id FROM visa_batches WHERE group_id = $1)`, [
      groupId,
    ]);
    await pool.query(`DELETE FROM visa_batch_applicants WHERE group_id = $1`, [groupId]);
    await pool.query(`DELETE FROM visa_batches WHERE group_id = $1`, [groupId]);
    await pool.query(`DELETE FROM passport_message_links WHERE group_id = $1`, [groupId]);
    await pool.query(`DELETE FROM telegram_messages WHERE group_id = $1`, [groupId]);
    await pool.query(
      `DELETE FROM passport_identity WHERE id IN (SELECT passport_identity_id FROM visa_batch_applicants WHERE group_id = $1)`,
      [groupId],
    );
    await pool.query(`DELETE FROM groups WHERE id = $1`, [groupId]);
  }
}

test('resolveReplyToVisaApplicant: NO_REPLY when there is nothing to reply to', async () => {
  const outcome = await resolveReplyToVisaApplicant(uniqueChatId(), null);
  assert.deepEqual(outcome, { kind: 'NO_REPLY' });
});

test('resolveReplyToVisaApplicant: MESSAGE_NOT_FOUND for a reply to an unknown/foreign message', async () => {
  const { groupId, chatId } = await createGroup();
  try {
    const outcome = await resolveReplyToVisaApplicant(chatId, 999999999);
    assert.deepEqual(outcome, { kind: 'MESSAGE_NOT_FOUND' });
  } finally {
    await cleanupAll([groupId]);
  }
});

test('resolveReplyToVisaApplicant: NO_ACTIVE_LINK when the message was never linked to any identity', async () => {
  const { groupId, chatId } = await createGroup();
  try {
    const { telegramMessageId } = await createPhotoMessage(groupId, chatId);
    const outcome = await resolveReplyToVisaApplicant(chatId, telegramMessageId);
    assert.deepEqual(outcome, { kind: 'NO_ACTIVE_LINK' });
  } finally {
    await cleanupAll([groupId]);
  }
});

test('resolveReplyToVisaApplicant: NO_ACTIVE_LINK when the link has been cancelled (no longer current)', async () => {
  const { groupId, chatId } = await createGroup();
  try {
    const identity = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
    assert.ok(identity);
    const { telegramMessageUuid, telegramMessageId } = await createPhotoMessage(groupId, chatId);
    await createActiveLink(telegramMessageUuid, identity.id, groupId);
    await pool.query(`UPDATE passport_message_links SET link_status = 'cancelled' WHERE telegram_message_id = $1`, [telegramMessageUuid]);

    const outcome = await resolveReplyToVisaApplicant(chatId, telegramMessageId);
    assert.deepEqual(outcome, { kind: 'NO_ACTIVE_LINK' });
  } finally {
    await cleanupAll([groupId]);
  }
});

test('resolveReplyToVisaApplicant: NO_BATCH_ASSIGNMENT when the identity was never assigned to a VisitSaudi batch', async () => {
  const { groupId, chatId } = await createGroup();
  try {
    const identity = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
    assert.ok(identity);
    const { telegramMessageUuid, telegramMessageId } = await createPhotoMessage(groupId, chatId);
    await createActiveLink(telegramMessageUuid, identity.id, groupId);

    const outcome = await resolveReplyToVisaApplicant(chatId, telegramMessageId);
    assert.deepEqual(outcome, { kind: 'NO_BATCH_ASSIGNMENT' });
  } finally {
    await cleanupAll([groupId]);
  }
});

test('resolveReplyToVisaApplicant: RESOLVED to the correct visa_batch_applicant id for a fully set-up reply', async () => {
  const { groupId, chatId } = await createGroup();
  try {
    const identity = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
    assert.ok(identity);
    const { telegramMessageUuid, telegramMessageId } = await createPhotoMessage(groupId, chatId);
    await createActiveLink(telegramMessageUuid, identity.id, groupId);
    const assignment = await assignVisaBatch(groupId, identity.id, 'visitsaudi', DEPARTURE_DATE);

    const outcome = await resolveReplyToVisaApplicant(chatId, telegramMessageId);
    assert.deepEqual(outcome, { kind: 'RESOLVED', visaBatchApplicantId: assignment.id });
  } finally {
    await cleanupAll([groupId]);
  }
});

test("resolveReplyToVisaApplicant: a reply to ANOTHER chat's message never resolves (scoped to the chat it was asked about)", async () => {
  const groupA = await createGroup();
  const groupB = await createGroup();
  try {
    const identity = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
    assert.ok(identity);
    const { telegramMessageUuid, telegramMessageId } = await createPhotoMessage(groupA.groupId, groupA.chatId);
    await createActiveLink(telegramMessageUuid, identity.id, groupA.groupId);
    await assignVisaBatch(groupA.groupId, identity.id, 'visitsaudi', DEPARTURE_DATE);

    // Same telegramMessageId value, but asked about groupB's chat -- must
    // not resolve, since findTelegramMessageByChatAndMessageId is scoped
    // to (chat, message), and this message was never posted in groupB's chat.
    const outcome = await resolveReplyToVisaApplicant(groupB.chatId, telegramMessageId);
    assert.deepEqual(outcome, { kind: 'MESSAGE_NOT_FOUND' });
  } finally {
    await cleanupAll([groupA.groupId, groupB.groupId]);
  }
});
