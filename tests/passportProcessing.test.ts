import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { pool } from '../src/db/pool.js';
import {
  createPassportProcessingRecord,
  findPassportProcessingById,
} from '../src/db/repositories/passportProcessing.repo.js';
import { processPassportProcessingJob } from '../src/worker/passportWorker.js';

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

interface Fixture {
  telegramMessageId: string;
  groupId: string;
  agentId: string;
  chatId: number;
}

async function createLinkedTelegramMessage(): Promise<Fixture> {
  const chatId = uniqueChatId();
  const senderId = uniqueUserId();

  const {
    rows: [group],
  } = await pool.query<{ id: string }>(
    `INSERT INTO groups (name, departure_date, telegram_chat_id) VALUES ($1, $2, $3) RETURNING id`,
    ['Worker Test Group', '2026-09-20', chatId],
  );
  const {
    rows: [agent],
  } = await pool.query<{ id: string }>(
    `INSERT INTO agents (name, telegram_user_id) VALUES ($1, $2) RETURNING id`,
    ['Worker Test Agent', senderId],
  );
  assert.ok(group);
  assert.ok(agent);

  const {
    rows: [message],
  } = await pool.query<{ id: string }>(
    `INSERT INTO telegram_messages (
       telegram_chat_id, telegram_message_id, telegram_sender_user_id, telegram_sender_display_name,
       message_timestamp, telegram_photo_file_id, group_id, agent_id
     ) VALUES ($1,$2,$3,'Worker Test Sender', now(), 'FILE_WORKER_TEST', $4, $5)
     RETURNING id`,
    [chatId, uniqueMessageId(), senderId, group.id, agent.id],
  );
  assert.ok(message);

  return { telegramMessageId: message.id, groupId: group.id, agentId: agent.id, chatId };
}

async function cleanup(fixture: Fixture): Promise<void> {
  // ON DELETE CASCADE from telegram_messages cleans up the passport_processing row too.
  await pool.query('DELETE FROM telegram_messages WHERE telegram_chat_id = $1', [fixture.chatId]);
  await pool.query('DELETE FROM groups WHERE id = $1', [fixture.groupId]);
  await pool.query('DELETE FROM agents WHERE id = $1', [fixture.agentId]);
}

test('createPassportProcessingRecord never creates a second record for the same telegram_message', async () => {
  const fixture = await createLinkedTelegramMessage();
  try {
    const first = await createPassportProcessingRecord(fixture.telegramMessageId);
    const second = await createPassportProcessingRecord(fixture.telegramMessageId);

    assert.ok(first);
    assert.equal(second, null);

    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*) FROM passport_processing WHERE telegram_message_id = $1`,
      [fixture.telegramMessageId],
    );
    assert.equal(rows[0]?.count, '1');
  } finally {
    await cleanup(fixture);
  }
});

test('processPassportProcessingJob marks a queued job completed on success', async () => {
  const fixture = await createLinkedTelegramMessage();
  try {
    const record = await createPassportProcessingRecord(fixture.telegramMessageId);
    assert.ok(record);

    await processPassportProcessingJob(fixture.telegramMessageId);

    const updated = await findPassportProcessingById(record.id);
    assert.equal(updated?.status, 'completed');
    assert.equal(updated?.attempts, 1);
    assert.ok(updated?.startedAt);
    assert.ok(updated?.completedAt);
    assert.equal(updated?.lastError, null);
  } finally {
    await cleanup(fixture);
  }
});

test('processPassportProcessingJob marks a job failed and records the error without throwing', async () => {
  const fixture = await createLinkedTelegramMessage();
  try {
    const record = await createPassportProcessingRecord(fixture.telegramMessageId);
    assert.ok(record);

    await assert.doesNotReject(() =>
      processPassportProcessingJob(fixture.telegramMessageId, async () => {
        throw new Error('simulated OCR failure');
      }),
    );

    const updated = await findPassportProcessingById(record.id);
    assert.equal(updated?.status, 'failed');
    assert.equal(updated?.lastError, 'simulated OCR failure');
    assert.equal(updated?.attempts, 1);
    assert.equal(updated?.completedAt, null);
  } finally {
    await cleanup(fixture);
  }
});

test('processPassportProcessingJob is a no-op when there is no processing record yet', async () => {
  const fixture = await createLinkedTelegramMessage();
  try {
    // No createPassportProcessingRecord call — simulates a stray/unexpected job id.
    await assert.doesNotReject(() => processPassportProcessingJob(fixture.telegramMessageId));

    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*) FROM passport_processing WHERE telegram_message_id = $1`,
      [fixture.telegramMessageId],
    );
    assert.equal(rows[0]?.count, '0');
  } finally {
    await cleanup(fixture);
  }
});

after(async () => {
  await pool.end();
});
