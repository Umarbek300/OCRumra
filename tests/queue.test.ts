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

before(async () => {
  await ensureRedisConnected();
  await redisClient.del(PASSPORT_PROCESSING_QUEUE);
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
  await enqueuePassportProcessing(telegramMessageId);

  const job = await dequeuePassportProcessing(5);
  assert.ok(job, 'expected a job to be dequeued');
  assert.equal(job?.telegramMessageId, telegramMessageId);
});

test('dequeuePassportProcessing returns null when the queue is empty within the timeout', async () => {
  const job = await dequeuePassportProcessing(1);
  assert.equal(job, null);
});

after(async () => {
  await redisClient.del(PASSPORT_PROCESSING_QUEUE);
  await redisClient.quit();
});
