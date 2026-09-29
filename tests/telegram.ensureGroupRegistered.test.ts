import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { pool } from '../src/db/pool.js';
import { createGroup, findGroupByTelegramChatId } from '../src/db/repositories/groups.repo.js';
import { createPassportProcessingRecord, findPassportProcessingByTelegramMessageId } from '../src/db/repositories/passportProcessing.repo.js';
import {
  findTelegramMessageById,
  findUnlinkedMessagesByTelegramChatId,
  linkTelegramMessageToGroup,
} from '../src/db/repositories/telegramMessages.repo.js';
import { dequeuePassportProcessing, enqueuePassportProcessing } from '../src/queue/passportProcessingQueue.js';
import { ensureRedisConnected, redisClient } from '../src/queue/redis.js';
import {
  ensureGroupRegistered as ensureGroupRegisteredWithProdDeps,
  type EnsureGroupRegisteredDependencies,
  type EnsureGroupRegisteredResult,
} from '../src/telegram/ensureGroupRegistered.js';

// Isolated from the real production queue (which the live
// ocrumra-worker.service actively consumes from) so these tests never race
// a live consumer for their own just-enqueued job, and never push fake test
// jobs onto the real queue. See passportProcessingQueue.ts's own doc
// comment on the queueName parameter this relies on.
const TEST_QUEUE_NAME = 'ocrumra:test:ensure-group-registered-queue';

const testDeps: EnsureGroupRegisteredDependencies = {
  findGroup: findGroupByTelegramChatId,
  createGroup,
  findUnlinked: findUnlinkedMessagesByTelegramChatId,
  linkMessage: linkTelegramMessageToGroup,
  createProcessingRecord: createPassportProcessingRecord,
  enqueueProcessing: (telegramMessageId: string) => enqueuePassportProcessing(telegramMessageId, TEST_QUEUE_NAME),
};

/** Every call in this file routes through testDeps above -- isolated from the real production queue. */
function ensureGroupRegistered(telegramChatId: number, chatTitle: string | null): Promise<EnsureGroupRegisteredResult> {
  return ensureGroupRegisteredWithProdDeps(telegramChatId, chatTitle, testDeps);
}

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

async function createAgent(): Promise<string> {
  const {
    rows: [agent],
  } = await pool.query<{ id: string }>(`INSERT INTO agents (name, telegram_user_id) VALUES ($1, $2) RETURNING id`, [
    'EnsureGroupRegistered Test Agent',
    uniqueUserId(),
  ]);
  assert.ok(agent);
  return agent.id;
}

/** Inserts a raw, already-unlinked telegram_messages row -- simulating messages that arrived before their group existed. */
async function createUnlinkedMessage(chatId: number, agentId: string | null): Promise<string> {
  const {
    rows: [message],
  } = await pool.query<{ id: string }>(
    `INSERT INTO telegram_messages (
       telegram_chat_id, telegram_message_id, telegram_sender_user_id, telegram_sender_display_name,
       message_timestamp, telegram_photo_file_id, group_id, agent_id
     ) VALUES ($1,$2,$3,'Backfill Test Sender', now(), 'FILE_BACKFILL_TEST', NULL, $4)
     RETURNING id`,
    [chatId, uniqueMessageId(), uniqueUserId(), agentId],
  );
  assert.ok(message);
  return message.id;
}

async function cleanup(chatId: number, groupId: string | null, agentIds: string[]): Promise<void> {
  await pool.query('DELETE FROM telegram_messages WHERE telegram_chat_id = $1', [chatId]);
  if (groupId) await pool.query('DELETE FROM groups WHERE id = $1', [groupId]);
  for (const agentId of agentIds) {
    await pool.query('DELETE FROM agents WHERE id = $1', [agentId]);
  }
  await redisClient.del(TEST_QUEUE_NAME);
}

before(async () => {
  await ensureRedisConnected();
  await redisClient.del(TEST_QUEUE_NAME);
});

test('creates a new group from a confidently-parsed title when the chat is unregistered', async () => {
  const chatId = uniqueChatId();
  let groupId: string | null = null;
  try {
    const result = await ensureGroupRegistered(chatId, '5 October 2026');
    assert.ok(result.group);
    groupId = result.group.id;
    assert.equal(result.group.name, '5 October 2026');
    assert.equal(result.group.departureDate, '2026-10-05');
    assert.equal(result.group.telegramChatId, String(chatId));
    assert.equal(result.group.googleSheetId, null, 'never provisions a Sheet from this path');
    assert.equal(result.backfilledMessageCount, 0);
  } finally {
    await cleanup(chatId, groupId, []);
  }
});

test('does NOT create a group when the title does not confidently parse -- message stays unresolved, never a guess', async () => {
  const chatId = uniqueChatId();
  try {
    const result = await ensureGroupRegistered(chatId, 'Random Chat Name');
    assert.equal(result.group, null);
    assert.equal(result.backfilledMessageCount, 0);

    const persisted = await findGroupByTelegramChatId(chatId);
    assert.equal(persisted, null, 'no group row was ever created');
  } finally {
    await cleanup(chatId, null, []);
  }
});

test('does NOT create a group when the title is null', async () => {
  const chatId = uniqueChatId();
  try {
    const result = await ensureGroupRegistered(chatId, null);
    assert.equal(result.group, null);
  } finally {
    await cleanup(chatId, null, []);
  }
});

test('finds an already-registered group WITHOUT creating a duplicate, and never overwrites its name/departure_date even when the current title differs', async () => {
  const chatId = uniqueChatId();
  const {
    rows: [existingGroup],
  } = await pool.query<{ id: string }>(
    `INSERT INTO groups (name, departure_date, telegram_chat_id) VALUES ($1, $2, $3) RETURNING id`,
    ['Original Manually-Corrected Name', '2026-09-20', chatId],
  );
  assert.ok(existingGroup);
  try {
    const result = await ensureGroupRegistered(chatId, '5 October 2026'); // a DIFFERENT, later, parseable title
    assert.ok(result.group);
    assert.equal(result.group.id, existingGroup.id, 'the SAME group row, never a second one');
    assert.equal(result.group.name, 'Original Manually-Corrected Name', 'name is never auto-overwritten');
    assert.equal(result.group.departureDate, '2026-09-20', 'departure_date is never auto-overwritten');

    const { rows: countRows } = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM groups WHERE telegram_chat_id = $1`,
      [chatId],
    );
    assert.equal(countRows[0]?.count, 1);
  } finally {
    await cleanup(chatId, existingGroup.id, []);
  }
});

test('backfills pre-existing unlinked messages once the group is auto-registered: links group_id, creates processing record, enqueues', async () => {
  const chatId = uniqueChatId();
  const agentId = await createAgent();
  const messageId = await createUnlinkedMessage(chatId, agentId);
  let groupId: string | null = null;
  try {
    const result = await ensureGroupRegistered(chatId, '5 October 2026');
    assert.ok(result.group);
    groupId = result.group.id;
    assert.equal(result.backfilledMessageCount, 1);

    const message = await findTelegramMessageById(messageId);
    assert.equal(message?.groupId, groupId);

    const processing = await findPassportProcessingByTelegramMessageId(messageId);
    assert.equal(processing?.status, 'queued');

    const job = await dequeuePassportProcessing(1, TEST_QUEUE_NAME);
    assert.equal(job?.telegramMessageId, messageId);
  } finally {
    await cleanup(chatId, groupId, [agentId]);
  }
});

test('backfill leaves a message with no registered agent unlinked-by-agent, and creates no processing record for it', async () => {
  const chatId = uniqueChatId();
  const messageId = await createUnlinkedMessage(chatId, null);
  let groupId: string | null = null;
  try {
    const result = await ensureGroupRegistered(chatId, '5 October 2026');
    assert.ok(result.group);
    groupId = result.group.id;
    assert.equal(result.backfilledMessageCount, 1, 'group_id IS patched');

    const message = await findTelegramMessageById(messageId);
    assert.equal(message?.groupId, groupId);
    assert.equal(message?.agentId, null, 'agent link is untouched -- not this function\'s job');

    const processing = await findPassportProcessingByTelegramMessageId(messageId);
    assert.equal(processing, null, 'no processing record without an agent -- matches ingestPhotoMessage\'s own gate');
  } finally {
    await cleanup(chatId, groupId, []);
  }
});

test('backfill sweep for an already-registered group also fixes messages that predate this feature entirely', async () => {
  const chatId = uniqueChatId();
  const agentId = await createAgent();
  const {
    rows: [existingGroup],
  } = await pool.query<{ id: string }>(
    `INSERT INTO groups (name, departure_date, telegram_chat_id) VALUES ($1, $2, $3) RETURNING id`,
    ['Pre-Existing Group', '2026-09-20', chatId],
  );
  assert.ok(existingGroup);
  const messageId = await createUnlinkedMessage(chatId, agentId);
  try {
    const result = await ensureGroupRegistered(chatId, 'Pre-Existing Group'); // an unparseable title on this call -- irrelevant, group already exists
    assert.equal(result.group?.id, existingGroup.id);
    assert.equal(result.backfilledMessageCount, 1);

    const message = await findTelegramMessageById(messageId);
    assert.equal(message?.groupId, existingGroup.id);
  } finally {
    await cleanup(chatId, existingGroup.id, [agentId]);
  }
});

test('repeated calls are idempotent -- no duplicate group, no duplicate processing record, no duplicate enqueue', async () => {
  const chatId = uniqueChatId();
  const agentId = await createAgent();
  const messageId = await createUnlinkedMessage(chatId, agentId);
  let groupId: string | null = null;
  try {
    const first = await ensureGroupRegistered(chatId, '5 October 2026');
    assert.ok(first.group);
    groupId = first.group.id;
    assert.equal(first.backfilledMessageCount, 1);

    const second = await ensureGroupRegistered(chatId, '5 October 2026');
    assert.equal(second.group?.id, groupId);
    assert.equal(second.backfilledMessageCount, 0, 'nothing left to backfill the second time');

    const { rows: groupCount } = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM groups WHERE telegram_chat_id = $1`,
      [chatId],
    );
    assert.equal(groupCount[0]?.count, 1);

    const { rows: processingCount } = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM passport_processing WHERE telegram_message_id = $1`,
      [messageId],
    );
    assert.equal(processingCount[0]?.count, 1);
  } finally {
    await cleanup(chatId, groupId, [agentId]);
  }
});

test('two concurrent auto-registrations for the SAME brand-new chat create exactly one group row', async () => {
  const chatId = uniqueChatId();
  let groupId: string | null = null;
  try {
    const [resultA, resultB] = await Promise.all([
      ensureGroupRegistered(chatId, '5 October 2026'),
      ensureGroupRegistered(chatId, '5 October 2026'),
    ]);
    assert.ok(resultA.group);
    assert.ok(resultB.group);
    assert.equal(resultA.group.id, resultB.group.id, 'both callers converge on the SAME group row');
    groupId = resultA.group.id;

    const { rows: countRows } = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM groups WHERE telegram_chat_id = $1`,
      [chatId],
    );
    assert.equal(countRows[0]?.count, 1, 'never two rows, even under a real race');
  } finally {
    await cleanup(chatId, groupId, []);
  }
});

test('does not touch an unrelated group\'s messages or data', async () => {
  const chatId = uniqueChatId();
  const unrelatedChatId = uniqueChatId();
  const {
    rows: [unrelatedGroup],
  } = await pool.query<{ id: string }>(
    `INSERT INTO groups (name, departure_date, telegram_chat_id) VALUES ($1, $2, $3) RETURNING id`,
    ['Unrelated Group', '2026-01-01', unrelatedChatId],
  );
  assert.ok(unrelatedGroup);
  const agentId = await createAgent();
  const unrelatedMessageId = await createUnlinkedMessage(unrelatedChatId, agentId);
  let groupId: string | null = null;
  try {
    const result = await ensureGroupRegistered(chatId, '5 October 2026');
    assert.ok(result.group);
    groupId = result.group.id;

    const unrelatedMessage = await findTelegramMessageById(unrelatedMessageId);
    assert.equal(unrelatedMessage?.groupId, null, 'a different chat\'s unlinked message is never touched by this call');

    const unrelatedGroupAfter = await findGroupByTelegramChatId(unrelatedChatId);
    assert.equal(unrelatedGroupAfter?.name, 'Unrelated Group');
    assert.equal(unrelatedGroupAfter?.departureDate, '2026-01-01');
  } finally {
    await cleanup(chatId, groupId, []);
    await cleanup(unrelatedChatId, unrelatedGroup.id, [agentId]);
  }
});

after(async () => {
  await pool.end();
  // Explicitly closes the shared Redis connection this file opened in
  // before() -- without this, the process can hang after all tests pass
  // instead of exiting (observed directly in this sandbox; harmless to
  // call even if some other mechanism would have closed it anyway).
  if (redisClient.isOpen) {
    await redisClient.quit();
  }
});
