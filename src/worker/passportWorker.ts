import {
  findPassportProcessingByTelegramMessageId,
  findStaleQueuedJobs,
  markPassportProcessingCompleted,
  markPassportProcessingFailed,
  markPassportProcessingStarted,
  recoverStaleProcessingJobs,
} from '../db/repositories/passportProcessing.repo.js';
import { findTelegramMessageById } from '../db/repositories/telegramMessages.repo.js';
import { dequeuePassportProcessing, enqueuePassportProcessing } from '../queue/passportProcessingQueue.js';
import { performPassportOcr, type OcrProcessingContext } from './performPassportOcr.js';

const POLL_TIMEOUT_SECONDS = 5;

/**
 * How often the poll loop's own heartbeat (the bounded BRPOP timeout below)
 * also triggers stale-job reconciliation, in addition to the one-time run
 * worker/start.ts already does before this loop begins. No separate timer
 * is used -- see runWorkerLoop's doc comment.
 */
export const RECONCILE_INTERVAL_MINUTES = 5;
const RECONCILE_INTERVAL_MS = RECONCILE_INTERVAL_MINUTES * 60_000;

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

export interface RecoverAndRequeueDependencies {
  /** Injectable for tests — defaults to the real DB reconciliation. */
  recover?: typeof recoverStaleProcessingJobs;
  /** Injectable for tests — defaults to the real stale-'queued' lookup. */
  findStaleQueued?: typeof findStaleQueuedJobs;
  /** Injectable for tests — defaults to the real Redis enqueue. */
  enqueue?: typeof enqueuePassportProcessing;
  /** Injectable for tests, to target an isolated test queue instead of the production one. */
  queueName?: string;
}

/**
 * Runs once at worker startup (see worker/start.ts) to recover two kinds
 * of job that can otherwise be lost forever:
 *
 *  - 'processing' rows abandoned by a previous crash/restart: flips
 *    still-retryable stale rows back to 'queued' and re-pushes them onto
 *    Redis so the poll loop picks them up again; rows already given up to
 *    'failed' by recoverStaleProcessingJobs are left alone.
 *
 *  - 'queued' rows that likely lost their Redis entry -- e.g. a worker
 *    crash between BRPOP (which pops irrevocably) and the
 *    markPassportProcessingStarted claim, or a transient Redis failure
 *    during the original enqueue in ingestPhotoMessage.ts. These are
 *    simply re-pushed onto Redis with their status left at 'queued';
 *    pushing a duplicate entry for a row that actually still has a live
 *    queue entry is always safe (see findStaleQueuedJobs's doc comment).
 *
 * A per-record Redis push failure (for either kind) is logged and skipped
 * rather than thrown, so one bad push can't abort recovery for the rest —
 * the row simply stays in its current state ('queued' either way here)
 * and will be picked up again by the next startup's reconciliation. Never
 * logs passport data — only the internal record id and coarse counts.
 */
export async function recoverAndRequeueStaleProcessingJobs(
  deps: RecoverAndRequeueDependencies = {},
): Promise<void> {
  const recover = deps.recover ?? recoverStaleProcessingJobs;
  const findStaleQueued = deps.findStaleQueued ?? findStaleQueuedJobs;
  const enqueue = deps.enqueue ?? enqueuePassportProcessing;

  const { requeued, failed } = await recover();
  const staleQueued = await findStaleQueued();
  const toRequeue = [...requeued, ...staleQueued];

  for (const record of toRequeue) {
    try {
      await enqueue(record.telegramMessageId, deps.queueName);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      console.error(`[passport-worker] failed to re-enqueue recovered job ${record.id}: ${message}`);
    }
  }

  if (toRequeue.length > 0 || failed.length > 0) {
    console.log(
      `[passport-worker] stale-job recovery: requeued=${toRequeue.length} ` +
        `(processing-recovered=${requeued.length}, queued-recovered=${staleQueued.length}) gave-up=${failed.length}`,
    );
  }
}

export interface RunWorkerLoopDependencies {
  /** Injectable for tests — defaults to the real Redis dequeue. */
  dequeue?: typeof dequeuePassportProcessing;
  /** Injectable for tests — defaults to the real job processor. */
  processJob?: typeof processPassportProcessingJob;
  /** Injectable for tests — defaults to the real stale-job reconciliation. */
  reconcile?: typeof recoverAndRequeueStaleProcessingJobs;
  /** Injectable for tests, to control simulated elapsed time deterministically — defaults to Date.now. */
  now?: () => number;
}

/**
 * Continuously polls the queue. `shouldContinue` lets the entrypoint stop
 * the loop gracefully (e.g. on SIGTERM) between poll cycles. A blocking
 * timeout is used so the loop periodically re-checks the shutdown flag
 * instead of blocking forever.
 *
 * That same bounded-BRPOP heartbeat also doubles as the tick for periodic
 * stale-job reconciliation -- no separate setInterval/setTimeout is used,
 * so there is nothing extra to clean up on shutdown; the existing
 * shouldContinue check already covers it. This is IN ADDITION to the
 * one-time reconciliation worker/start.ts already runs before this loop
 * begins: that startup run can't see a 'queued' row that gets orphaned
 * later without the worker ever crashing (e.g. a transient DB error mid-
 * processPassportProcessingJob, caught by the try/catch below without
 * reaching markPassportProcessingStarted) -- this periodic tick bounds how
 * long such a row can sit unrecovered to roughly RECONCILE_INTERVAL_MINUTES
 * instead of "until the next restart".
 *
 * A reconciliation failure is never caught here -- like a dequeue failure,
 * it propagates so the worker crashes and systemd restarts it, consistent
 * with this loop's existing failure policy.
 */
export async function runWorkerLoop(
  shouldContinue: () => boolean = () => true,
  deps: RunWorkerLoopDependencies = {},
): Promise<void> {
  const dequeue = deps.dequeue ?? dequeuePassportProcessing;
  const processJob = deps.processJob ?? processPassportProcessingJob;
  const reconcile = deps.reconcile ?? recoverAndRequeueStaleProcessingJobs;
  const now = deps.now ?? Date.now;

  let lastReconcileAt = now();

  while (shouldContinue()) {
    if (now() - lastReconcileAt >= RECONCILE_INTERVAL_MS) {
      await reconcile();
      lastReconcileAt = now();
    }

    const job = await dequeue(POLL_TIMEOUT_SECONDS);
    if (!job) continue;

    try {
      await processJob(job.telegramMessageId);
    } catch (error) {
      // processPassportProcessingJob already handles its own failures; this
      // is a last-resort guard so one unexpected bug can't kill the worker.
      const message = error instanceof Error ? error.message : 'unknown error';
      console.error(`[passport-worker] unexpected error handling job ${job.telegramMessageId}: ${message}`);
    }
  }
}
