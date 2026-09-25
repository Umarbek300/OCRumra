import { ensureRedisConnected, redisClient } from './redis.js';

export const PASSPORT_PROCESSING_QUEUE = 'ocrumra:passport-processing';

export interface PassportProcessingQueuePayload {
  telegramMessageId: string;
  queuedAt: string;
}

/** Pure so it can be tested without a Redis connection. */
export function buildPassportProcessingPayload(telegramMessageId: string): PassportProcessingQueuePayload {
  return { telegramMessageId, queuedAt: new Date().toISOString() };
}

/**
 * Pushes the telegram_messages.id (never the photo binary) onto the queue.
 * Callers decide whether a message is eligible (linked + newly inserted) —
 * this function unconditionally enqueues whatever id it's given.
 *
 * `queueName` defaults to the real production queue; it exists only so
 * integration tests can point at a unique, isolated key instead of racing
 * the live worker on the shared production queue. No production caller
 * passes it, so production behavior is unchanged.
 */
export async function enqueuePassportProcessing(
  telegramMessageId: string,
  queueName: string = PASSPORT_PROCESSING_QUEUE,
): Promise<void> {
  await ensureRedisConnected();
  const payload = buildPassportProcessingPayload(telegramMessageId);
  await redisClient.lPush(queueName, JSON.stringify(payload));
}

/**
 * Blocks up to `timeoutSeconds` for a job. Returns null on timeout so the
 * worker loop can re-check its shutdown flag instead of blocking forever.
 *
 * `queueName` defaults to the real production queue — see
 * enqueuePassportProcessing's doc comment for why the parameter exists.
 */
export async function dequeuePassportProcessing(
  timeoutSeconds: number,
  queueName: string = PASSPORT_PROCESSING_QUEUE,
): Promise<PassportProcessingQueuePayload | null> {
  await ensureRedisConnected();
  const result = await redisClient.brPop(queueName, timeoutSeconds);
  if (!result) return null;
  return JSON.parse(result.element) as PassportProcessingQueuePayload;
}
