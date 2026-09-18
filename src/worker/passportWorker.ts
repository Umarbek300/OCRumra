import { findTelegramMessageById } from '../db/repositories/telegramMessages.repo.js';
import {
  findPassportProcessingByTelegramMessageId,
  markPassportProcessingCompleted,
  markPassportProcessingFailed,
  markPassportProcessingStarted,
} from '../db/repositories/passportProcessing.repo.js';
import { dequeuePassportProcessing } from '../queue/passportProcessingQueue.js';

const POLL_TIMEOUT_SECONDS = 5;

export interface SimulateProcessingContext {
  telegramMessageId: string;
  groupId: string;
  agentId: string;
}

export type SimulateProcessing = (context: SimulateProcessingContext) => Promise<void>;

/**
 * PLACEHOLDER for the future OCR/AI extraction step. This stage only
 * proves the queue -> worker -> status pipeline; no OCR is performed here.
 */
const defaultSimulateProcessing: SimulateProcessing = async (context) => {
  console.log(
    `[passport-worker] PLACEHOLDER processing step (no OCR performed) for ` +
      `telegram_message=${context.telegramMessageId} group=${context.groupId} agent=${context.agentId}`,
  );
};

/**
 * Processes a single job by telegram_message id. Exported separately from
 * the Redis polling loop so it can be tested directly (including the
 * failure path, via an injected simulateProcessing) without a live queue.
 * Never throws — a failure is recorded on the processing row, not raised.
 */
export async function processPassportProcessingJob(
  telegramMessageId: string,
  simulateProcessing: SimulateProcessing = defaultSimulateProcessing,
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
    await simulateProcessing({
      telegramMessageId,
      groupId: telegramMessage.groupId,
      agentId: telegramMessage.agentId,
    });
    await markPassportProcessingCompleted(claimed.id);
    console.log(`[passport-worker] completed telegram_message=${telegramMessageId}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[passport-worker] failed telegram_message=${telegramMessageId}: ${message}`);
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
      console.error('[passport-worker] unexpected error handling job', job, error);
    }
  }
}
