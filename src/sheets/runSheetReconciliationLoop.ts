import { env } from '../config/env.js';
import { findDueReconciliationJobs, recoverStaleReconciliationJobs } from '../db/repositories/sheetReconciliation.repo.js';
import { reconcileSheetRow } from './reconcileSheetRow.js';

/** Same fixed-interval-poll shape as runSheetSyncLoop.ts — no separate broker for this table either. */
const POLL_INTERVAL_MS = 5000;

/** Same cadence/reasoning as runSheetSyncLoop.ts's own RECONCILE_INTERVAL_MINUTES. */
export const RECONCILE_INTERVAL_MINUTES = 5;
const RECONCILE_INTERVAL_MS = RECONCILE_INTERVAL_MINUTES * 60_000;

export interface ReconcileStaleReconciliationJobsDependencies {
  recover: typeof recoverStaleReconciliationJobs;
}

/** One reconciliation pass over sheet_reconciliation_jobs itself — recovers 'processing' rows abandoned by a crashed worker. Same convention as runSheetSyncLoop.ts's reconcileStaleSyncingJobs. */
export async function reconcileStaleReconciliationJobs(
  deps: ReconcileStaleReconciliationJobsDependencies = { recover: recoverStaleReconciliationJobs },
): Promise<void> {
  const { requeued, failed } = await deps.recover();
  if (requeued.length > 0 || failed.length > 0) {
    console.log(`[sheet-reconciliation] stale-processing recovery: requeued=${requeued.length} gave-up=${failed.length}`);
  }
}

export interface RunSheetReconciliationLoopDependencies {
  findDue: typeof findDueReconciliationJobs;
  processJob: typeof reconcileSheetRow;
  reconcile: typeof reconcileStaleReconciliationJobs;
  isEnabled: () => boolean;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

const defaultDependencies: RunSheetReconciliationLoopDependencies = {
  findDue: findDueReconciliationJobs,
  processJob: reconcileSheetRow,
  reconcile: reconcileStaleReconciliationJobs,
  isEnabled: () => env.SHEETS_SYNC_ENABLED,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: Date.now,
};

/**
 * Polls sheet_reconciliation_jobs for due rows and processes each via
 * reconcileSheetRow, which does its own atomic claim. Same concurrent-safe
 * shape as runSheetSyncLoop.ts. Gated by the same SHEETS_SYNC_ENABLED flag
 * as the ordinary sync loop — both write to the same Sheets, so both
 * respect the same kill switch.
 *
 * Intended to run alongside runSheetSyncLoop inside the SAME sheets:worker
 * process (see src/sheets/start.ts) rather than as its own process — one
 * more independent polling loop, not a new service to operate.
 */
export async function runSheetReconciliationLoop(
  shouldContinue: () => boolean = () => true,
  deps: RunSheetReconciliationLoopDependencies = defaultDependencies,
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
        console.error(`[sheet-reconciliation] unexpected error handling job ${job.id}: ${message}`);
      }
    }
  }
}
