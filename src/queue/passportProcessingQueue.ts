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
 */
export async function enqueuePassportProcessing(telegramMessageId: string): Promise<void> {
  await ensureRedisConnected();
  const payload = buildPassportProcessingPayload(telegramMessageId);
  await redisClient.lPush(PASSPORT_PROCESSING_QUEUE, JSON.stringify(payload));
}

/**
 * Blocks up to `timeoutSeconds` for a job. Returns null on timeout so the
 * worker loop can re-check its shutdown flag instead of blocking forever.
 */
export async function dequeuePassportProcessing(
  timeoutSeconds: number,
): Promise<PassportProcessingQueuePayload | null> {
  await ensureRedisConnected();
  const result = await redisClient.brPop(PASSPORT_PROCESSING_QUEUE, timeoutSeconds);
  if (!result) return null;
  return JSON.parse(result.element) as PassportProcessingQueuePayload;
}
