import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { pool } from '../src/db/pool.js';
import {
  createPassportProcessingRecord,
  findPassportProcessingById,
  findStaleQueuedJobs,
  markPassportProcessingStarted,
  MAX_PROCESSING_ATTEMPTS,
  recoverStaleProcessingJobs,
} from '../src/db/repositories/passportProcessing.repo.js';
import { PASSPORT_PROCESSING_QUEUE, dequeuePassportProcessing } from '../src/queue/passportProcessingQueue.js';
import { redisClient } from '../src/queue/redis.js';
import { processPassportProcessingJob, recoverAndRequeueStaleProcessingJobs } from '../src/worker/passportWorker.js';

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

async function backdateStartedAtMinutes(id: string, minutesAgo: number): Promise<void> {
  await pool.query(
    `UPDATE passport_processing SET started_at = now() - ($2 * interval '1 minute') WHERE id = $1`,
    [id, minutesAgo],
  );
}

async function setAttempts(id: string, attempts: number): Promise<void> {
  await pool.query('UPDATE passport_processing SET attempts = $2 WHERE id = $1', [id, attempts]);
}

async function backdateQueuedAtMinutes(id: string, minutesAgo: number): Promise<void> {
  await pool.query(
    `UPDATE passport_processing SET queued_at = now() - ($2 * interval '1 minute') WHERE id = $1`,
    [id, minutesAgo],
  );
}

/**
 * recoverStaleProcessingJobs() operates globally across the whole table,
 * not scoped to one fixture -- on the real (production) database used by
 * this suite, a pre-existing real stuck job would also match its WHERE
 * clause. Refuse to run these tests if one is already present rather than
 * risk silently flipping a real job's status: at worst that job would end
 * up 'queued' with no Redis entry (or worse, requeued only onto a
 * throwaway test queue that gets deleted), permanently losing it.
 */
async function assertNoPreexistingStaleProcessingRows(): Promise<void> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*) FROM passport_processing WHERE status = 'processing' AND started_at < now() - interval '10 minutes'`,
  );
  assert.equal(
    Number(rows[0]?.count ?? '0'),
    0,
    'refusing to run stale-processing-recovery tests: a real processing row already looks stale in the ' +
      'database. Investigate it manually before running this suite.',
  );
}

/** Same safety rationale as assertNoPreexistingStaleProcessingRows, for the 'queued' side. */
async function assertNoPreexistingStaleQueuedRows(): Promise<void> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*) FROM passport_processing WHERE status = 'queued' AND queued_at < now() - interval '10 minutes'`,
  );
  assert.equal(
    Number(rows[0]?.count ?? '0'),
    0,
    'refusing to run stale-queued-recovery tests: a real queued row already looks stale in the ' +
      'database. Investigate it manually before running this suite.',
  );
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

    let callCount = 0;
    // Mocked OCR step — this test is about the lifecycle state machine, not
    // Claude/Telegram themselves (those are covered in their own test files).
    await processPassportProcessingJob(fixture.telegramMessageId, async () => {
      callCount += 1;
    });

    assert.equal(callCount, 1);
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

test('a duplicate queue item for an already-completed job is skipped and never re-runs OCR', async () => {
  const fixture = await createLinkedTelegramMessage();
  try {
    const record = await createPassportProcessingRecord(fixture.telegramMessageId);
    assert.ok(record);

    let callCount = 0;
    const mockOcr = async () => {
      callCount += 1;
    };

    // First delivery: processes normally.
    await processPassportProcessingJob(fixture.telegramMessageId, mockOcr);
    assert.equal(callCount, 1);

    const afterFirst = await findPassportProcessingById(record.id);
    assert.equal(afterFirst?.status, 'completed');

    // Telegram/Redis redelivers the same job id — the atomic queued-state
    // claim guard means the OCR step must not run a second time.
    await processPassportProcessingJob(fixture.telegramMessageId, mockOcr);
    assert.equal(callCount, 1, 'OCR must not be invoked again for an already-completed job');

    const afterSecond = await findPassportProcessingById(record.id);
    assert.equal(afterSecond?.status, 'completed');
    assert.equal(afterSecond?.attempts, 1);
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

// --- stale 'processing' job recovery ---------------------------------------
// Covers the scenario where a worker crashes/is killed between dequeuing a
// job from Redis (which removes it irrevocably -- see BRPOP semantics in
// passportProcessingQueue.ts) and marking the row completed/failed: the row
// is left stuck at status='processing' forever unless recovered.

test('recoverStaleProcessingJobs requeues a processing job stuck past the staleness timeout', async () => {
  await assertNoPreexistingStaleProcessingRows();
  const fixture = await createLinkedTelegramMessage();
  try {
    const record = await createPassportProcessingRecord(fixture.telegramMessageId);
    assert.ok(record);
    const claimed = await markPassportProcessingStarted(record.id);
    assert.ok(claimed);
    assert.equal(claimed.attempts, 1);
    await backdateStartedAtMinutes(record.id, 20);

    const result = await recoverStaleProcessingJobs();

    const recovered = result.requeued.find((r) => r.id === record.id);
    assert.ok(recovered, 'expected the stale row to be requeued');
    assert.ok(!result.failed.some((r) => r.id === record.id));

    const updated = await findPassportProcessingById(record.id);
    assert.equal(updated?.status, 'queued');
    assert.equal(updated?.attempts, 1, 'recovery must not itself bump attempts -- the next claim does that');
  } finally {
    await cleanup(fixture);
  }
});

test('recoverStaleProcessingJobs leaves a fresh (not-yet-stale) processing job untouched', async () => {
  await assertNoPreexistingStaleProcessingRows();
  const fixture = await createLinkedTelegramMessage();
  try {
    const record = await createPassportProcessingRecord(fixture.telegramMessageId);
    assert.ok(record);
    const claimed = await markPassportProcessingStarted(record.id);
    assert.ok(claimed);
    // started_at defaults to now() -- well within the staleness timeout.

    const result = await recoverStaleProcessingJobs();

    assert.ok(!result.requeued.some((r) => r.id === record.id));
    assert.ok(!result.failed.some((r) => r.id === record.id));

    const updated = await findPassportProcessingById(record.id);
    assert.equal(updated?.status, 'processing');
  } finally {
    await cleanup(fixture);
  }
});

test('recoverStaleProcessingJobs gives up a stale processing job once attempts reach the limit, marking it failed instead of requeuing', async () => {
  await assertNoPreexistingStaleProcessingRows();
  const fixture = await createLinkedTelegramMessage();
  try {
    const record = await createPassportProcessingRecord(fixture.telegramMessageId);
    assert.ok(record);
    const claimed = await markPassportProcessingStarted(record.id);
    assert.ok(claimed);
    await setAttempts(record.id, MAX_PROCESSING_ATTEMPTS);
    await backdateStartedAtMinutes(record.id, 20);

    const result = await recoverStaleProcessingJobs();

    assert.ok(!result.requeued.some((r) => r.id === record.id));
    const gaveUp = result.failed.find((r) => r.id === record.id);
    assert.ok(gaveUp, 'expected the row to be given up to failed, not requeued');

    const updated = await findPassportProcessingById(record.id);
    assert.equal(updated?.status, 'failed');
    assert.ok(updated?.lastError);
  } finally {
    await cleanup(fixture);
  }
});

test('recoverAndRequeueStaleProcessingJobs pushes a recovered stale job onto the Redis queue', async () => {
  await assertNoPreexistingStaleProcessingRows();
  const fixture = await createLinkedTelegramMessage();
  const testQueueName = `${PASSPORT_PROCESSING_QUEUE}:test:${randomUUID()}`;
  try {
    const record = await createPassportProcessingRecord(fixture.telegramMessageId);
    assert.ok(record);
    const claimed = await markPassportProcessingStarted(record.id);
    assert.ok(claimed);
    await backdateStartedAtMinutes(record.id, 20);

    await recoverAndRequeueStaleProcessingJobs({ queueName: testQueueName });

    const updated = await findPassportProcessingById(record.id);
    assert.equal(updated?.status, 'queued');

    const job = await dequeuePassportProcessing(5, testQueueName);
    assert.ok(job, 'expected the recovered job to appear on the Redis queue');
    assert.equal(job?.telegramMessageId, fixture.telegramMessageId);
  } finally {
    await redisClient.del(testQueueName);
    await cleanup(fixture);
  }
});

test('recoverAndRequeueStaleProcessingJobs is idempotent: a second run does not re-requeue an already-recovered job', async () => {
  await assertNoPreexistingStaleProcessingRows();
  const fixture = await createLinkedTelegramMessage();
  const testQueueName = `${PASSPORT_PROCESSING_QUEUE}:test:${randomUUID()}`;
  try {
    const record = await createPassportProcessingRecord(fixture.telegramMessageId);
    assert.ok(record);
    const claimed = await markPassportProcessingStarted(record.id);
    assert.ok(claimed);
    await backdateStartedAtMinutes(record.id, 20);

    await recoverAndRequeueStaleProcessingJobs({ queueName: testQueueName });
    const firstJob = await dequeuePassportProcessing(5, testQueueName);
    assert.ok(firstJob, 'first run must recover and enqueue the stale job');

    // The row is now 'queued', not 'processing', so a second run must not match it again.
    await recoverAndRequeueStaleProcessingJobs({ queueName: testQueueName });
    const secondJob = await dequeuePassportProcessing(1, testQueueName);
    assert.equal(secondJob, null, 'a second recovery run must not push a duplicate job');

    const updated = await findPassportProcessingById(record.id);
    assert.equal(updated?.status, 'queued');
  } finally {
    await redisClient.del(testQueueName);
    await cleanup(fixture);
  }
});

// --- stale 'queued' job recovery (lost-Redis-entry orphans) ----------------
// Covers the gap the 'processing' recovery above cannot see: a worker
// crash between BRPOP (which pops the job from Redis irrevocably -- see
// passportProcessingQueue.ts) and markPassportProcessingStarted's claim, or
// a transient Redis failure during the original enqueue in
// ingestPhotoMessage.ts, both leave a row at status='queued' with no
// corresponding Redis entry -- invisible to recoverStaleProcessingJobs,
// which only ever looks at status='processing'.

test('findStaleQueuedJobs finds a queued job stuck past the staleness timeout, without changing its status', async () => {
  await assertNoPreexistingStaleQueuedRows();
  const fixture = await createLinkedTelegramMessage();
  try {
    const record = await createPassportProcessingRecord(fixture.telegramMessageId);
    assert.ok(record);
    assert.equal(record.status, 'queued');
    await backdateQueuedAtMinutes(record.id, 20);

    const stale = await findStaleQueuedJobs();

    assert.ok(stale.some((r) => r.id === record.id), 'expected the stale queued row to be found');

    const updated = await findPassportProcessingById(record.id);
    assert.equal(updated?.status, 'queued', 'findStaleQueuedJobs must never itself change status');
  } finally {
    await cleanup(fixture);
  }
});

test('findStaleQueuedJobs leaves a fresh (not-yet-stale) queued job out of the result', async () => {
  const fixture = await createLinkedTelegramMessage();
  try {
    const record = await createPassportProcessingRecord(fixture.telegramMessageId);
    assert.ok(record);
    // queued_at defaults to now() -- well within the staleness timeout.

    const stale = await findStaleQueuedJobs();

    assert.ok(!stale.some((r) => r.id === record.id));
  } finally {
    await cleanup(fixture);
  }
});

test('recoverAndRequeueStaleProcessingJobs pushes a stale queued job onto the Redis queue while leaving its DB status as queued', async () => {
  await assertNoPreexistingStaleQueuedRows();
  const fixture = await createLinkedTelegramMessage();
  const testQueueName = `${PASSPORT_PROCESSING_QUEUE}:test:${randomUUID()}`;
  try {
    const record = await createPassportProcessingRecord(fixture.telegramMessageId);
    assert.ok(record);
    await backdateQueuedAtMinutes(record.id, 20);

    await recoverAndRequeueStaleProcessingJobs({ queueName: testQueueName });

    const updated = await findPassportProcessingById(record.id);
    assert.equal(updated?.status, 'queued', 'a recovered queued job must stay queued -- no status transition needed');

    const job = await dequeuePassportProcessing(5, testQueueName);
    assert.ok(job, 'expected the recovered job to appear on the Redis queue');
    assert.equal(job?.telegramMessageId, fixture.telegramMessageId);
  } finally {
    await redisClient.del(testQueueName);
    await cleanup(fixture);
  }
});

test('recoverAndRequeueStaleProcessingJobs does not push a fresh (not-yet-stale) queued job', async () => {
  const fixture = await createLinkedTelegramMessage();
  const testQueueName = `${PASSPORT_PROCESSING_QUEUE}:test:${randomUUID()}`;
  try {
    const record = await createPassportProcessingRecord(fixture.telegramMessageId);
    assert.ok(record);
    // queued_at defaults to now() -- fresh, must not be recovered.

    await recoverAndRequeueStaleProcessingJobs({ queueName: testQueueName });

    const job = await dequeuePassportProcessing(1, testQueueName);
    assert.equal(job, null, 'a fresh queued job must not be pushed by recovery');
  } finally {
    await redisClient.del(testQueueName);
    await cleanup(fixture);
  }
});

test('recovering the same stale queued job twice produces a harmless duplicate Redis entry: the atomic queued-state claim guarantees OCR still runs exactly once', async () => {
  await assertNoPreexistingStaleQueuedRows();
  const fixture = await createLinkedTelegramMessage();
  const testQueueName = `${PASSPORT_PROCESSING_QUEUE}:test:${randomUUID()}`;
  try {
    const record = await createPassportProcessingRecord(fixture.telegramMessageId);
    assert.ok(record);
    await backdateQueuedAtMinutes(record.id, 20);

    // Two recovery runs back-to-back: findStaleQueuedJobs is read-only, so
    // the row still matches on the second run and gets pushed again.
    await recoverAndRequeueStaleProcessingJobs({ queueName: testQueueName });
    await recoverAndRequeueStaleProcessingJobs({ queueName: testQueueName });

    const firstJob = await dequeuePassportProcessing(5, testQueueName);
    const secondJob = await dequeuePassportProcessing(1, testQueueName);
    assert.ok(firstJob, 'expected the first (duplicate) Redis entry');
    assert.ok(secondJob, 'expected the second (duplicate) Redis entry -- confirms the duplicate actually landed on Redis');
    assert.equal(firstJob?.telegramMessageId, fixture.telegramMessageId);
    assert.equal(secondJob?.telegramMessageId, fixture.telegramMessageId);

    let callCount = 0;
    const mockOcr = async () => {
      callCount += 1;
    };

    // Simulate the worker loop processing both queue entries in turn.
    await processPassportProcessingJob(fixture.telegramMessageId, mockOcr);
    await processPassportProcessingJob(fixture.telegramMessageId, mockOcr);

    assert.equal(callCount, 1, 'OCR must run exactly once even though the job was pushed onto Redis twice');
    const updated = await findPassportProcessingById(record.id);
    assert.equal(updated?.status, 'completed');
  } finally {
    await redisClient.del(testQueueName);
    await cleanup(fixture);
  }
});

test('recoverAndRequeueStaleProcessingJobs leaves a stale queued job at status=queued when the Redis push itself fails', async () => {
  await assertNoPreexistingStaleQueuedRows();
  const fixture = await createLinkedTelegramMessage();
  try {
    const record = await createPassportProcessingRecord(fixture.telegramMessageId);
    assert.ok(record);
    await backdateQueuedAtMinutes(record.id, 20);

    const failingEnqueue = async () => {
      throw new Error('simulated Redis outage');
    };

    await assert.doesNotReject(() =>
      recoverAndRequeueStaleProcessingJobs({ enqueue: failingEnqueue }),
    );

    const updated = await findPassportProcessingById(record.id);
    assert.equal(updated?.status, 'queued', 'a failed re-enqueue must leave the row queued, not lose or change it');
  } finally {
    await cleanup(fixture);
  }
});

test('recoverAndRequeueStaleProcessingJobs recovers a stale processing job and a stale queued job in the same run, without interfering with each other', async () => {
  await assertNoPreexistingStaleProcessingRows();
  await assertNoPreexistingStaleQueuedRows();
  const processingFixture = await createLinkedTelegramMessage();
  const queuedFixture = await createLinkedTelegramMessage();
  const testQueueName = `${PASSPORT_PROCESSING_QUEUE}:test:${randomUUID()}`;
  try {
    const processingRecord = await createPassportProcessingRecord(processingFixture.telegramMessageId);
    assert.ok(processingRecord);
    const claimed = await markPassportProcessingStarted(processingRecord.id);
    assert.ok(claimed);
    await backdateStartedAtMinutes(processingRecord.id, 20);

    const queuedRecord = await createPassportProcessingRecord(queuedFixture.telegramMessageId);
    assert.ok(queuedRecord);
    await backdateQueuedAtMinutes(queuedRecord.id, 20);

    await recoverAndRequeueStaleProcessingJobs({ queueName: testQueueName });

    const updatedProcessing = await findPassportProcessingById(processingRecord.id);
    assert.equal(updatedProcessing?.status, 'queued', 'the stale processing job must be requeued as before');

    const updatedQueued = await findPassportProcessingById(queuedRecord.id);
    assert.equal(updatedQueued?.status, 'queued', 'the stale queued job must remain queued');

    const jobIds = new Set<string>();
    for (let i = 0; i < 2; i++) {
      const job = await dequeuePassportProcessing(5, testQueueName);
      assert.ok(job, `expected job #${i + 1} on the Redis queue`);
      jobIds.add(job!.telegramMessageId);
    }
    assert.ok(jobIds.has(processingFixture.telegramMessageId));
    assert.ok(jobIds.has(queuedFixture.telegramMessageId));
  } finally {
    await redisClient.del(testQueueName);
    await cleanup(processingFixture);
    await cleanup(queuedFixture);
  }
});

after(async () => {
  await redisClient.quit().catch(() => undefined);
  await pool.end();
});
