import { env } from '../config/env.js';
import { findDueSheetSyncJobs, recoverStaleSyncingJobs } from '../db/repositories/sheetSyncQueue.repo.js';
import { syncPassportRowToSheet } from './syncPassportRowToSheet.js';

/** No BRPOP/Redis available here (unlike passportProcessingQueue) — a plain fixed-interval poll is simple, sufficient, and keeps this worker fully independent of Redis. */
const POLL_INTERVAL_MS = 5000;

/** Same cadence as passportWorker.ts's RECONCILE_INTERVAL_MINUTES — same underlying concern (a crashed worker can leave a row stuck mid-processing), same interval. */
export const RECONCILE_INTERVAL_MINUTES = 5;
const RECONCILE_INTERVAL_MS = RECONCILE_INTERVAL_MINUTES * 60_000;

export interface ReconcileStaleSyncingJobsDependencies {
  recover: typeof recoverStaleSyncingJobs;
}

/**
 * One reconciliation pass: recovers 'syncing' rows abandoned by a crashed/
 * killed sync worker (see recoverStaleSyncingJobs's own doc comment in
 * sheetSyncQueue.repo.ts) and logs a summary only when there was something
 * to report — same convention as passportWorker.ts's
 * recoverAndRequeueStaleProcessingJobs.
 *
 * Unlike that OCR-worker equivalent, there is no separate "re-push onto
 * Redis" step here: recoverStaleSyncingJobs itself already sets a
 * recovered row's status to 'pending' with next_attempt_at = now(), which
 * is exactly what findDueSheetSyncJobs's own WHERE clause selects — so a
 * recovered row becomes eligible again on the very next poll with no
 * further action needed.
 *
 * Called both once at worker startup (src/sheets/start.ts, before the
 * first poll — recovers anything left stuck by a previous crash) and
 * periodically from inside runSheetSyncLoop below, on RECONCILE_INTERVAL_MINUTES.
 */
export async function reconcileStaleSyncingJobs(
  deps: ReconcileStaleSyncingJobsDependencies = { recover: recoverStaleSyncingJobs },
): Promise<void> {
  const { requeued, failed } = await deps.recover();
  if (requeued.length > 0 || failed.length > 0) {
    console.log(`[sheets-sync] stale-syncing recovery: requeued=${requeued.length} gave-up=${failed.length}`);
  }
}

export interface RunSheetSyncLoopDependencies {
  findDue: typeof findDueSheetSyncJobs;
  processJob: typeof syncPassportRowToSheet;
  /** Injectable for tests — defaults to the real reconcileStaleSyncingJobs. */
  reconcile: typeof reconcileStaleSyncingJobs;
  isEnabled: () => boolean;
  sleep: (ms: number) => Promise<void>;
  /** Injectable for tests, to control simulated elapsed time deterministically — defaults to Date.now. */
  now: () => number;
}

const defaultDependencies: RunSheetSyncLoopDependencies = {
  findDue: findDueSheetSyncJobs,
  processJob: syncPassportRowToSheet,
  reconcile: reconcileStaleSyncingJobs,
  isEnabled: () => env.SHEETS_SYNC_ENABLED,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: Date.now,
};

/**
 * Polls sheet_sync_queue for due jobs (pending/failed, next_attempt_at <=
 * now) and processes each one via syncPassportRowToSheet, which does its
 * own atomic DB claim (markSheetSyncStarted — pending/failed -> syncing).
 * That single-claim guarantee is what makes running two instances of this
 * loop concurrently safe: both may see the same due job in the same poll,
 * but only one's claim can ever succeed; the other's syncPassportRowToSheet
 * call simply no-ops for that job (see its "not claimable" early return).
 * No Redis anywhere in this loop.
 *
 * `shouldContinue` lets the entrypoint (start.ts) request a graceful stop
 * between poll cycles — same pattern runWorkerLoop already uses for the
 * OCR worker. Also re-checked between individual jobs within one batch, so
 * a shutdown request doesn't have to wait for a large due-jobs batch to
 * fully drain first.
 *
 * When SHEETS_SYNC_ENABLED is false, the loop still runs (so flipping it
 * to true takes effect without a process restart) but does no DB/Sheets
 * *syncing* work — it still runs its periodic stale-job reconciliation
 * (see below), then just sleeps and rechecks the flag every cycle.
 *
 * A periodic reconciliation tick (reconcile, every RECONCILE_INTERVAL_MINUTES)
 * is checked first on every iteration, before the enabled-gate — mirrors
 * passportWorker.ts's runWorkerLoop exactly (same bounded-heartbeat-doubles-
 * as-reconcile-tick shape, no separate setInterval/setTimeout, nothing
 * extra to clean up on shutdown). A reconcile failure (e.g. the database
 * itself is unreachable) is deliberately NOT caught here — like a
 * findDue() failure below, it propagates out of this function so
 * start.ts's caller can log it as a fatal, systemic error and exit with a
 * clear reason, letting the process supervisor restart it — the same
 * policy runWorkerLoop already applies to its own dequeue/reconcile
 * failures.
 *
 * A single job's failure is fully handled inside syncPassportRowToSheet
 * itself (it never throws — see its own try/catch). The try/catch here is
 * a last-resort guard only, identical in spirit to runWorkerLoop's own,
 * so a genuinely unexpected bug in processing one job can never take down
 * the whole loop or stop later jobs from being tried.
 */
export async function runSheetSyncLoop(
  shouldContinue: () => boolean = () => true,
  deps: RunSheetSyncLoopDependencies = defaultDependencies,
): Promise<void> {
  let lastReconcileAt = deps.now();

  while (shouldContinue()) {
    if (deps.now() - lastReconcileAt >= RECONCILE_INTERVAL_MS) {
      await deps.reconcile();
      lastReconcileAt = deps.now();
    }

    if (!deps.isEnabled()) {
      await deps.sleep(POLL_INTERVAL_MS);
      continue;
    }

    const dueJobs = await deps.findDue();

    if (dueJobs.length === 0) {
      await deps.sleep(POLL_INTERVAL_MS);
      continue;
    }

    for (const job of dueJobs) {
      if (!shouldContinue()) break;
      try {
        await deps.processJob(job.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown error';
        console.error(`[sheets-sync] unexpected error handling job ${job.id}: ${message}`);
      }
    }
  }
}
