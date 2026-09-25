import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import {
  PASSPORT_PROCESSING_QUEUE,
  buildPassportProcessingPayload,
  dequeuePassportProcessing,
  enqueuePassportProcessing,
} from '../src/queue/passportProcessingQueue.js';
import { ensureRedisConnected, redisClient } from '../src/queue/redis.js';

// A unique, isolated key per test run — the live production worker only
// ever blocks on PASSPORT_PROCESSING_QUEUE itself, so a distinct key here
// means this test's own jobs can never be raced away by production.
const TEST_QUEUE_NAME = `${PASSPORT_PROCESSING_QUEUE}:test:${randomUUID()}`;

before(async () => {
  await ensureRedisConnected();
  await redisClient.del(TEST_QUEUE_NAME);
});

test('buildPassportProcessingPayload creates a payload with the message id and a queuedAt timestamp', () => {
  const telegramMessageId = randomUUID();
  const payload = buildPassportProcessingPayload(telegramMessageId);

  assert.equal(payload.telegramMessageId, telegramMessageId);
  assert.ok(!Number.isNaN(new Date(payload.queuedAt).getTime()), 'queuedAt should be a valid timestamp');

  // Must be plain-JSON serializable — this is exactly what goes onto Redis.
  const roundTripped = JSON.parse(JSON.stringify(payload));
  assert.deepEqual(roundTripped, payload);

  // The image binary must never be part of the payload.
  assert.deepEqual(Object.keys(payload).sort(), ['queuedAt', 'telegramMessageId']);
});

test('the queue name matches the ocrumra:passport-processing convention', () => {
  assert.equal(PASSPORT_PROCESSING_QUEUE, 'ocrumra:passport-processing');
});

test('enqueuePassportProcessing pushes a payload that dequeuePassportProcessing reads back', async () => {
  const telegramMessageId = randomUUID();
  await enqueuePassportProcessing(telegramMessageId, TEST_QUEUE_NAME);

  const job = await dequeuePassportProcessing(5, TEST_QUEUE_NAME);
  assert.ok(job, 'expected a job to be dequeued');
  assert.equal(job?.telegramMessageId, telegramMessageId);
});

test('dequeuePassportProcessing returns null when the queue is empty within the timeout', async () => {
  const job = await dequeuePassportProcessing(1, TEST_QUEUE_NAME);
  assert.equal(job, null);
});

after(async () => {
  await redisClient.del(TEST_QUEUE_NAME);
  await redisClient.quit();
});
