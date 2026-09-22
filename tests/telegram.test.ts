import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { findPassportProcessingByTelegramMessageId } from '../src/db/repositories/passportProcessing.repo.js';
import { pool } from '../src/db/pool.js';
import { listLinkedMessages, listUnlinkedMessages } from '../src/db/repositories/telegramMessages.repo.js';
import { PASSPORT_PROCESSING_QUEUE, dequeuePassportProcessing } from '../src/queue/passportProcessingQueue.js';
import { ensureRedisConnected, redisClient } from '../src/queue/redis.js';
import { ingestPhotoMessage } from '../src/telegram/ingestPhotoMessage.js';

// Telegram chat/user ids are safe-integer numbers; generate collision-free
// fixture ids so parallel/rerun test invocations never clash with leftovers.
let idCounter = 0;
function uniqueChatId(): number {
  idCounter += 1;
  return -1 * (Date.now() * 1000 + idCounter);
}
function uniqueUserId(): number {
  idCounter += 1;
  return Date.now() * 1000 + idCounter;
}
function uniqueMessageId(): number {
  idCounter += 1;
  return idCounter;
}

async function createGroup(telegramChatId: number): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO groups (name, departure_date, telegram_chat_id) VALUES ($1, $2, $3) RETURNING id`,
    ['Telegram Test Group', '2026-09-20', telegramChatId],
  );
  const row = rows[0];
  assert.ok(row);
  return row.id;
}

async function createAgent(telegramUserId: number): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO agents (name, telegram_user_id) VALUES ($1, $2) RETURNING id`,
    ['Telegram Test Agent', telegramUserId],
  );
  const row = rows[0];
  assert.ok(row);
  return row.id;
}

async function deleteFixtures(chatId: number, groupId: string | null, agentId: string | null): Promise<void> {
  // ON DELETE CASCADE from telegram_messages cleans up any passport_processing row too.
  await pool.query('DELETE FROM telegram_messages WHERE telegram_chat_id = $1', [chatId]);
  if (groupId) await pool.query('DELETE FROM groups WHERE id = $1', [groupId]);
  if (agentId) await pool.query('DELETE FROM agents WHERE id = $1', [agentId]);
  // Every test in this file shares one real Redis queue; drain anything a
  // test enqueued but didn't explicitly consume so later tests never race
  // against another test's leftover job (Redis lists are FIFO here).
  await redisClient.del(PASSPORT_PROCESSING_QUEUE);
}

before(async () => {
  await ensureRedisConnected();
  await redisClient.del(PASSPORT_PROCESSING_QUEUE);
});

test('links a photo message when the chat and sender are both registered', async () => {
  const chatId = uniqueChatId();
  const senderId = uniqueUserId();
  const groupId = await createGroup(chatId);
  const agentId = await createAgent(senderId);
  try {
    const result = await ingestPhotoMessage({
      chatId,
      messageId: uniqueMessageId(),
      senderUserId: senderId,
      senderDisplayName: 'Test Sender',
      timestamp: new Date(),
      photoFileId: 'FILE_LINKED',
      source: 'photo',
    });
    assert.deepEqual(result, {
      outcome: 'inserted',
      groupLinked: true,
      agentLinked: true,
      processingEnqueued: true,
    });

    const linked = await listLinkedMessages();
    const match = linked.find((m) => m.telegramChatId === String(chatId));
    assert.equal(match?.source, 'photo');
  } finally {
    await deleteFixtures(chatId, groupId, agentId);
  }
});

test('links a document-sourced message and records source=document, unaffected by the photo workflow', async () => {
  const chatId = uniqueChatId();
  const senderId = uniqueUserId();
  const groupId = await createGroup(chatId);
  const agentId = await createAgent(senderId);
  try {
    const result = await ingestPhotoMessage({
      chatId,
      messageId: uniqueMessageId(),
      senderUserId: senderId,
      senderDisplayName: 'Test Sender',
      timestamp: new Date(),
      photoFileId: 'FILE_DOCUMENT',
      source: 'document',
    });
    assert.deepEqual(result, {
      outcome: 'inserted',
      groupLinked: true,
      agentLinked: true,
      processingEnqueued: true,
    });

    const linked = await listLinkedMessages();
    const match = linked.find((m) => m.telegramChatId === String(chatId));
    assert.equal(match?.source, 'document');
    assert.equal(match?.telegramPhotoFileId, 'FILE_DOCUMENT');
  } finally {
    await deleteFixtures(chatId, groupId, agentId);
  }
});

test('records an unlinked message when the chat is not a registered Group', async () => {
  const chatId = uniqueChatId();
  const senderId = uniqueUserId();
  const agentId = await createAgent(senderId);
  try {
    const messageId = uniqueMessageId();
    const result = await ingestPhotoMessage({
      chatId,
      messageId,
      senderUserId: senderId,
      senderDisplayName: 'Registered Agent',
      timestamp: new Date(),
      photoFileId: 'FILE_UNKNOWN_GROUP',
      source: 'photo',
    });
    assert.deepEqual(result, {
      outcome: 'inserted',
      groupLinked: false,
      agentLinked: true,
      processingEnqueued: false,
    });

    const unlinked = await listUnlinkedMessages();
    const match = unlinked.find(
      (m) => m.telegramChatId === String(chatId) && m.telegramMessageId === String(messageId),
    );
    assert.ok(match, 'expected the message to appear in listUnlinkedMessages');
    assert.equal(match?.groupId, null);
    assert.equal(match?.agentId, agentId);
  } finally {
    await deleteFixtures(chatId, null, agentId);
  }
});

test('records an unlinked message when the sender is not a registered Agent', async () => {
  const chatId = uniqueChatId();
  const senderId = uniqueUserId();
  const groupId = await createGroup(chatId);
  try {
    const messageId = uniqueMessageId();
    const result = await ingestPhotoMessage({
      chatId,
      messageId,
      senderUserId: senderId,
      senderDisplayName: 'Unregistered Sender',
      timestamp: new Date(),
      photoFileId: 'FILE_UNKNOWN_AGENT',
      source: 'photo',
    });
    assert.deepEqual(result, {
      outcome: 'inserted',
      groupLinked: true,
      agentLinked: false,
      processingEnqueued: false,
    });

    const unlinked = await listUnlinkedMessages();
    const match = unlinked.find(
      (m) => m.telegramChatId === String(chatId) && m.telegramMessageId === String(messageId),
    );
    assert.ok(match, 'expected the message to appear in listUnlinkedMessages');
    assert.equal(match?.groupId, groupId);
    assert.equal(match?.agentId, null);

    // Never falls back to guessing an Agent from the display name.
    assert.equal(match?.telegramSenderDisplayName, 'Unregistered Sender');
  } finally {
    await deleteFixtures(chatId, groupId, null);
  }
});

test('the same (chat, message) id is never processed into a duplicate row', async () => {
  const chatId = uniqueChatId();
  const senderId = uniqueUserId();
  const groupId = await createGroup(chatId);
  const agentId = await createAgent(senderId);
  try {
    const messageId = uniqueMessageId();
    const first = await ingestPhotoMessage({
      chatId,
      messageId,
      senderUserId: senderId,
      senderDisplayName: 'Test Sender',
      timestamp: new Date(),
      photoFileId: 'FILE_ORIGINAL',
      source: 'photo',
    });
    const second = await ingestPhotoMessage({
      chatId,
      messageId,
      senderUserId: senderId,
      senderDisplayName: 'Test Sender',
      timestamp: new Date(),
      photoFileId: 'FILE_REDELIVERED',
      source: 'photo',
    });

    assert.equal(first.outcome, 'inserted');
    assert.equal(first.processingEnqueued, true);
    assert.equal(second.outcome, 'duplicate');
    assert.equal(second.processingEnqueued, false);

    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*) FROM telegram_messages WHERE telegram_chat_id = $1 AND telegram_message_id = $2`,
      [chatId, messageId],
    );
    assert.equal(rows[0]?.count, '1');
  } finally {
    await deleteFixtures(chatId, groupId, agentId);
  }
});

test('listLinkedMessages and listUnlinkedMessages partition messages correctly', async () => {
  const chatId = uniqueChatId();
  const senderId = uniqueUserId();
  const groupId = await createGroup(chatId);
  const agentId = await createAgent(senderId);
  const strangerId = uniqueUserId();
  try {
    const linkedMessageId = uniqueMessageId();
    const unlinkedMessageId = uniqueMessageId();

    await ingestPhotoMessage({
      chatId,
      messageId: linkedMessageId,
      senderUserId: senderId,
      senderDisplayName: 'Test Sender',
      timestamp: new Date(),
      photoFileId: 'FILE_LINKED_2',
      source: 'photo',
    });
    await ingestPhotoMessage({
      chatId,
      messageId: unlinkedMessageId,
      senderUserId: strangerId,
      senderDisplayName: 'Stranger',
      timestamp: new Date(),
      photoFileId: 'FILE_UNLINKED_2',
      source: 'photo',
    });

    const linked = await listLinkedMessages();
    const unlinked = await listUnlinkedMessages();

    assert.ok(linked.some((m) => m.telegramMessageId === String(linkedMessageId)));
    assert.ok(!linked.some((m) => m.telegramMessageId === String(unlinkedMessageId)));
    assert.ok(unlinked.some((m) => m.telegramMessageId === String(unlinkedMessageId)));
    assert.ok(!unlinked.some((m) => m.telegramMessageId === String(linkedMessageId)));
  } finally {
    await deleteFixtures(chatId, groupId, agentId);
  }
});

test('a fully linked new message gets a passport_processing record and is pushed onto the queue', async () => {
  const chatId = uniqueChatId();
  const senderId = uniqueUserId();
  const groupId = await createGroup(chatId);
  const agentId = await createAgent(senderId);
  try {
    const result = await ingestPhotoMessage({
      chatId,
      messageId: uniqueMessageId(),
      senderUserId: senderId,
      senderDisplayName: 'Test Sender',
      timestamp: new Date(),
      photoFileId: 'FILE_QUEUED',
      source: 'photo',
    });
    assert.equal(result.processingEnqueued, true);

    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM telegram_messages WHERE telegram_chat_id = $1`,
      [chatId],
    );
    const telegramMessageId = rows[0]?.id;
    assert.ok(telegramMessageId);

    const processingRecord = await findPassportProcessingByTelegramMessageId(telegramMessageId);
    assert.ok(processingRecord, 'expected a passport_processing record to exist');
    assert.equal(processingRecord?.status, 'queued');
    assert.equal(processingRecord?.attempts, 0);

    const job = await dequeuePassportProcessing(5);
    assert.ok(job, 'expected the message id to have been pushed onto the Redis queue');
    assert.equal(job?.telegramMessageId, telegramMessageId);
  } finally {
    await deleteFixtures(chatId, groupId, agentId);
  }
});

test('an unlinked message does not get a passport_processing record or a queue entry', async () => {
  const chatId = uniqueChatId();
  const senderId = uniqueUserId();
  // No group registered for this chatId — the message stays unlinked.
  const agentId = await createAgent(senderId);
  try {
    const result = await ingestPhotoMessage({
      chatId,
      messageId: uniqueMessageId(),
      senderUserId: senderId,
      senderDisplayName: 'Test Sender',
      timestamp: new Date(),
      photoFileId: 'FILE_NOT_QUEUED',
      source: 'photo',
    });
    assert.equal(result.processingEnqueued, false);

    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM telegram_messages WHERE telegram_chat_id = $1`,
      [chatId],
    );
    const telegramMessageId = rows[0]?.id;
    assert.ok(telegramMessageId);

    const processingRecord = await findPassportProcessingByTelegramMessageId(telegramMessageId);
    assert.equal(processingRecord, null);

    const job = await dequeuePassportProcessing(1);
    assert.equal(job, null, 'expected nothing to have been pushed onto the Redis queue');
  } finally {
    await deleteFixtures(chatId, null, agentId);
  }
});

after(async () => {
  await redisClient.del(PASSPORT_PROCESSING_QUEUE);
  await redisClient.quit();
  await pool.end();
});
