import {
  findPassportProcessingByTelegramMessageId,
  markPassportProcessingCompleted,
  markPassportProcessingFailed,
  markPassportProcessingStarted,
} from '../db/repositories/passportProcessing.repo.js';
import { findTelegramMessageById } from '../db/repositories/telegramMessages.repo.js';
import { dequeuePassportProcessing } from '../queue/passportProcessingQueue.js';
import { performPassportOcr, type OcrProcessingContext } from './performPassportOcr.js';

const POLL_TIMEOUT_SECONDS = 5;

export type PerformPassportOcr = (context: OcrProcessingContext) => Promise<void>;

/**
 * Processes a single job by telegram_message id. Exported separately from
 * the Redis polling loop so it can be tested directly (including the
 * failure path, via an injected performPassportOcr) without a live queue.
 * Never throws — a failure is recorded on the processing row, not raised.
 * Never logs passport data — only the message id and coarse status.
 */
export async function processPassportProcessingJob(
  telegramMessageId: string,
  performOcr: PerformPassportOcr = performPassportOcr,
): Promise<void> {
  const processingRecord = await findPassportProcessingByTelegramMessageId(telegramMessageId);
  if (!processingRecord) {
    console.warn(
      `[passport-worker] no passport_processing record for telegram_message=${telegramMessageId}; skipping`,
    );
    return;
  }

  const telegramMessage = await findTelegramMessageById(telegramMessageId);
  if (!telegramMessage || !telegramMessage.groupId || !telegramMessage.agentId) {
    console.warn(
      `[passport-worker] telegram_message=${telegramMessageId} is missing group_id/agent_id; ` +
        `marking processing record ${processingRecord.id} failed`,
    );
    await markPassportProcessingFailed(
      processingRecord.id,
      'telegram_messages row is missing group_id or agent_id',
    );
    return;
  }

  // Atomic queued -> processing claim: also the guard against a duplicate
  // queue item being processed twice, and against retrying a 'failed' job
  // (out of scope until the reliability stage — it simply won't be 'queued').
  const claimed = await markPassportProcessingStarted(processingRecord.id);
  if (!claimed) {
    console.log(
      `[passport-worker] processing record ${processingRecord.id} was not in 'queued' state; skipping ` +
        '(already claimed or previously processed)',
    );
    return;
  }

  console.log(
    `[passport-worker] processing telegram_message=${telegramMessageId} ` +
      `group=${telegramMessage.groupId} agent=${telegramMessage.agentId} attempt=${claimed.attempts}`,
  );

  try {
    await performOcr({
      telegramMessageId,
      telegramPhotoFileId: telegramMessage.telegramPhotoFileId,
      groupId: telegramMessage.groupId,
      agentId: telegramMessage.agentId,
    });
    await markPassportProcessingCompleted(claimed.id);
    console.log(`[passport-worker] OCR processing completed for message ${telegramMessageId}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    console.error(`[passport-worker] OCR processing failed for message ${telegramMessageId}: ${message}`);
    await markPassportProcessingFailed(claimed.id, message);
  }
}

/**
 * Continuously polls the queue. `shouldContinue` lets the entrypoint stop
 * the loop gracefully (e.g. on SIGTERM) between poll cycles. A blocking
 * timeout is used so the loop periodically re-checks the shutdown flag
 * instead of blocking forever.
 */
export async function runWorkerLoop(shouldContinue: () => boolean = () => true): Promise<void> {
  while (shouldContinue()) {
    const job = await dequeuePassportProcessing(POLL_TIMEOUT_SECONDS);
    if (!job) continue;

    try {
      await processPassportProcessingJob(job.telegramMessageId);
    } catch (error) {
      // processPassportProcessingJob already handles its own failures; this
      // is a last-resort guard so one unexpected bug can't kill the worker.
      const message = error instanceof Error ? error.message : 'unknown error';
      console.error(`[passport-worker] unexpected error handling job ${job.telegramMessageId}: ${message}`);
    }
  }
}
