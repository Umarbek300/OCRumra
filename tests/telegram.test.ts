import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { findPassportProcessingByTelegramMessageId } from '../src/db/repositories/passportProcessing.repo.js';
import { pool } from '../src/db/pool.js';
import { findGroupByTelegramChatId } from '../src/db/repositories/groups.repo.js';
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
      captionText: null,
      mediaGroupId: null,
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
      captionText: null,
      mediaGroupId: null,
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
      captionText: null,
      mediaGroupId: null,
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
      captionText: null,
      mediaGroupId: null,
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

test('auto-registers a new group from the chat title and links the message, when the title confidently parses', async () => {
  const chatId = uniqueChatId();
  const senderId = uniqueUserId();
  const agentId = await createAgent(senderId);
  let groupId: string | null = null;
  try {
    const result = await ingestPhotoMessage({
      chatId,
      messageId: uniqueMessageId(),
      senderUserId: senderId,
      senderDisplayName: 'Test Sender',
      timestamp: new Date(),
      photoFileId: 'FILE_AUTO_REGISTER',
      source: 'photo',
      captionText: null,
      mediaGroupId: null,
      chatTitle: '5 October 2026',
    });
    assert.deepEqual(result, {
      outcome: 'inserted',
      groupLinked: true,
      agentLinked: true,
      processingEnqueued: true,
    });

    const group = await findGroupByTelegramChatId(chatId);
    assert.ok(group);
    groupId = group.id;
    assert.equal(group.name, '5 October 2026');
    assert.equal(group.departureDate, '2026-10-05');
  } finally {
    await deleteFixtures(chatId, groupId, agentId);
  }
});

test('an unparseable chat title never auto-creates a group -- message stays unlinked exactly like the no-title case', async () => {
  const chatId = uniqueChatId();
  const senderId = uniqueUserId();
  const agentId = await createAgent(senderId);
  try {
    const result = await ingestPhotoMessage({
      chatId,
      messageId: uniqueMessageId(),
      senderUserId: senderId,
      senderDisplayName: 'Test Sender',
      timestamp: new Date(),
      photoFileId: 'FILE_UNPARSEABLE_TITLE',
      source: 'photo',
      captionText: null,
      mediaGroupId: null,
      chatTitle: 'Some Random Chat Name',
    });
    assert.deepEqual(result, {
      outcome: 'inserted',
      groupLinked: false,
      agentLinked: true,
      processingEnqueued: false,
    });

    assert.equal(await findGroupByTelegramChatId(chatId), null, 'no group was ever created from an unparseable title');
  } finally {
    await deleteFixtures(chatId, null, agentId);
  }
});

test('omitting chatTitle entirely preserves the exact pre-existing unlinked behavior', async () => {
  const chatId = uniqueChatId();
  const senderId = uniqueUserId();
  const agentId = await createAgent(senderId);
  try {
    const result = await ingestPhotoMessage({
      chatId,
      messageId: uniqueMessageId(),
      senderUserId: senderId,
      senderDisplayName: 'Test Sender',
      timestamp: new Date(),
      photoFileId: 'FILE_NO_TITLE_FIELD',
      source: 'photo',
      captionText: null,
      mediaGroupId: null,
      // chatTitle deliberately omitted
    });
    assert.deepEqual(result, {
      outcome: 'inserted',
      groupLinked: false,
      agentLinked: true,
      processingEnqueued: false,
    });
  } finally {
    await deleteFixtures(chatId, null, agentId);
  }
});

test('a second message in an already auto-registered chat links straight away, without creating a second group', async () => {
  const chatId = uniqueChatId();
  const senderId = uniqueUserId();
  const agentId = await createAgent(senderId);
  let groupId: string | null = null;
  try {
    const first = await ingestPhotoMessage({
      chatId,
      messageId: uniqueMessageId(),
      senderUserId: senderId,
      senderDisplayName: 'Test Sender',
      timestamp: new Date(),
      photoFileId: 'FILE_FIRST_AUTO',
      source: 'photo',
      captionText: null,
      mediaGroupId: null,
      chatTitle: '5 October 2026',
    });
    assert.equal(first.groupLinked, true);

    const second = await ingestPhotoMessage({
      chatId,
      messageId: uniqueMessageId(),
      senderUserId: senderId,
      senderDisplayName: 'Test Sender',
      timestamp: new Date(),
      photoFileId: 'FILE_SECOND_AUTO',
      source: 'photo',
      captionText: null,
      mediaGroupId: null,
      chatTitle: '5 October 2026',
    });
    assert.equal(second.groupLinked, true);

    const group = await findGroupByTelegramChatId(chatId);
    assert.ok(group);
    groupId = group.id;

    const { rows } = await pool.query<{ count: number }>(`SELECT count(*)::int AS count FROM groups WHERE telegram_chat_id = $1`, [
      chatId,
    ]);
    assert.equal(rows[0]?.count, 1);
  } finally {
    await deleteFixtures(chatId, groupId, agentId);
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
      captionText: null,
      mediaGroupId: null,
    });
    const second = await ingestPhotoMessage({
      chatId,
      messageId,
      senderUserId: senderId,
      senderDisplayName: 'Test Sender',
      timestamp: new Date(),
      photoFileId: 'FILE_REDELIVERED',
      source: 'photo',
      captionText: null,
      mediaGroupId: null,
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
      captionText: null,
      mediaGroupId: null,
    });
    await ingestPhotoMessage({
      chatId,
      messageId: unlinkedMessageId,
      senderUserId: strangerId,
      senderDisplayName: 'Stranger',
      timestamp: new Date(),
      photoFileId: 'FILE_UNLINKED_2',
      source: 'photo',
      captionText: null,
      mediaGroupId: null,
    });

    const linked = await listLinkedMessages();
    const unlinked = await listUnlinkedMessages();

    // telegram_message_id alone is only unique WITHIN a chat (Telegram's own
    // scheme, and this file's uniqueMessageId() is a small sequential
    // integer, not globally unique) -- listLinkedMessages/listUnlinkedMessages
    // are deliberately global (unscoped) admin queries (see admin/debug.ts),
    // so matching on chatId + messageId together avoids a false match against
    // an unrelated chat's row that happens to share this test's small id.
    const isThisLinkedMessage = (m: { telegramMessageId: string; telegramChatId: string }): boolean =>
      m.telegramMessageId === String(linkedMessageId) && m.telegramChatId === String(chatId);
    const isThisUnlinkedMessage = (m: { telegramMessageId: string; telegramChatId: string }): boolean =>
      m.telegramMessageId === String(unlinkedMessageId) && m.telegramChatId === String(chatId);

    assert.ok(linked.some(isThisLinkedMessage));
    assert.ok(!linked.some(isThisUnlinkedMessage));
    assert.ok(unlinked.some(isThisUnlinkedMessage));
    assert.ok(!unlinked.some(isThisLinkedMessage));
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
      captionText: null,
      mediaGroupId: null,
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
    // status='queued' in Postgres is the authoritative, durable signal that
    // enqueue succeeded (see enqueuePassportProcessing's own doc comment) --
    // deliberately NOT re-verified via a Redis dequeue here: ingestPhotoMessage.ts
    // pushes onto the real production PASSPORT_PROCESSING_QUEUE with no
    // per-call override, so a live ocrumra-worker.service can legitimately
    // pop this exact job before this test gets to it, which is correct
    // production behavior, not a test failure.
    assert.equal(processingRecord?.status, 'queued');
    assert.equal(processingRecord?.attempts, 0);
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
      captionText: null,
      mediaGroupId: null,
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

// --- media-group (album) caption correlation ---
// Telegram attaches a caption to only ONE message of an album; every
// sibling photo/document arrives with caption = null even when the
// operator wrote one caption for the whole album.

test('a message with no caption of its own borrows an already-recorded sibling album message\'s caption', async () => {
  const chatId = uniqueChatId();
  const senderId = uniqueUserId();
  const groupId = await createGroup(chatId);
  const agentId = await createAgent(senderId);
  const mediaGroupId = `album-${uniqueMessageId()}`;
  try {
    // First photo in the album: carries the caption.
    await ingestPhotoMessage({
      chatId,
      messageId: uniqueMessageId(),
      senderUserId: senderId,
      senderDisplayName: 'Test Sender',
      timestamp: new Date(),
      photoFileId: 'FILE_ALBUM_1',
      source: 'photo',
      captionText: 'Package: Standard $1400',
      mediaGroupId,
    });

    // Second photo in the SAME album: Telegram itself never puts a caption here.
    const result = await ingestPhotoMessage({
      chatId,
      messageId: uniqueMessageId(),
      senderUserId: senderId,
      senderDisplayName: 'Test Sender',
      timestamp: new Date(),
      photoFileId: 'FILE_ALBUM_2',
      source: 'photo',
      captionText: null,
      mediaGroupId,
    });
    assert.equal(result.outcome, 'inserted');

    const linked = await listLinkedMessages();
    const second = linked.find((m) => m.telegramPhotoFileId === 'FILE_ALBUM_2');
    assert.equal(second?.captionText, 'Package: Standard $1400', 'borrowed the sibling\'s caption, never left null');
  } finally {
    await deleteFixtures(chatId, groupId, agentId);
  }
});

test('a caption-carrying message backfills an earlier sibling in the same album that arrived without one', async () => {
  const chatId = uniqueChatId();
  const senderId = uniqueUserId();
  const groupId = await createGroup(chatId);
  const agentId = await createAgent(senderId);
  const mediaGroupId = `album-${uniqueMessageId()}`;
  try {
    // First photo arrives WITHOUT a caption (the caption-carrying photo in
    // this album is the second one to arrive -- order is not guaranteed).
    await ingestPhotoMessage({
      chatId,
      messageId: uniqueMessageId(),
      senderUserId: senderId,
      senderDisplayName: 'Test Sender',
      timestamp: new Date(),
      photoFileId: 'FILE_ALBUM_EARLY',
      source: 'photo',
      captionText: null,
      mediaGroupId,
    });

    // Second photo carries the caption.
    await ingestPhotoMessage({
      chatId,
      messageId: uniqueMessageId(),
      senderUserId: senderId,
      senderDisplayName: 'Test Sender',
      timestamp: new Date(),
      photoFileId: 'FILE_ALBUM_LATE',
      source: 'photo',
      captionText: 'Deposit: $200',
      mediaGroupId,
    });

    const linked = await listLinkedMessages();
    const early = linked.find((m) => m.telegramPhotoFileId === 'FILE_ALBUM_EARLY');
    assert.equal(early?.captionText, 'Deposit: $200', 'the earlier sibling was backfilled once the caption arrived');
  } finally {
    await deleteFixtures(chatId, groupId, agentId);
  }
});

test('a standalone message (no media_group_id) never borrows a caption from an unrelated message', async () => {
  const chatId = uniqueChatId();
  const senderId = uniqueUserId();
  const groupId = await createGroup(chatId);
  const agentId = await createAgent(senderId);
  try {
    // An unrelated captioned message in the same chat, but NOT in any album.
    await ingestPhotoMessage({
      chatId,
      messageId: uniqueMessageId(),
      senderUserId: senderId,
      senderDisplayName: 'Test Sender',
      timestamp: new Date(),
      photoFileId: 'FILE_UNRELATED_CAPTIONED',
      source: 'photo',
      captionText: 'Package: $999',
      mediaGroupId: null,
    });

    const result = await ingestPhotoMessage({
      chatId,
      messageId: uniqueMessageId(),
      senderUserId: senderId,
      senderDisplayName: 'Test Sender',
      timestamp: new Date(),
      photoFileId: 'FILE_STANDALONE_NO_CAPTION',
      source: 'photo',
      captionText: null,
      mediaGroupId: null,
    });
    assert.equal(result.outcome, 'inserted');

    const linked = await listLinkedMessages();
    const standalone = linked.find((m) => m.telegramPhotoFileId === 'FILE_STANDALONE_NO_CAPTION');
    assert.equal(standalone?.captionText, null, 'never borrows a caption across unrelated, non-album messages');
  } finally {
    await deleteFixtures(chatId, groupId, agentId);
  }
});

test('never overwrites a sibling\'s own already-known caption when backfilling', async () => {
  const chatId = uniqueChatId();
  const senderId = uniqueUserId();
  const groupId = await createGroup(chatId);
  const agentId = await createAgent(senderId);
  const mediaGroupId = `album-${uniqueMessageId()}`;
  try {
    // Two photos in the same album, each with its OWN distinct caption --
    // an unusual but possible case (Telegram clients don't normally do
    // this, but nothing here should assume they can't).
    await ingestPhotoMessage({
      chatId,
      messageId: uniqueMessageId(),
      senderUserId: senderId,
      senderDisplayName: 'Test Sender',
      timestamp: new Date(),
      photoFileId: 'FILE_ALBUM_OWN_CAPTION_1',
      source: 'photo',
      captionText: 'Package: $1000',
      mediaGroupId,
    });
    await ingestPhotoMessage({
      chatId,
      messageId: uniqueMessageId(),
      senderUserId: senderId,
      senderDisplayName: 'Test Sender',
      timestamp: new Date(),
      photoFileId: 'FILE_ALBUM_OWN_CAPTION_2',
      source: 'photo',
      captionText: 'Deposit: $100',
      mediaGroupId,
    });

    const linked = await listLinkedMessages();
    const first = linked.find((m) => m.telegramPhotoFileId === 'FILE_ALBUM_OWN_CAPTION_1');
    const second = linked.find((m) => m.telegramPhotoFileId === 'FILE_ALBUM_OWN_CAPTION_2');
    assert.equal(first?.captionText, 'Package: $1000', 'keeps its own caption, never overwritten by the sibling');
    assert.equal(second?.captionText, 'Deposit: $100', 'keeps its own caption, never borrowed the earlier sibling\'s');
  } finally {
    await deleteFixtures(chatId, groupId, agentId);
  }
});

after(async () => {
  await redisClient.del(PASSPORT_PROCESSING_QUEUE);
  await redisClient.quit();
  await pool.end();
});
