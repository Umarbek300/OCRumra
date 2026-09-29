import { findPendingCommands, recoverStaleOperatorCommands } from '../db/repositories/passportOperatorCommands.repo.js';
import { processPassportOperatorCommand } from './processOperatorCommand.js';

/** Same shape as runSheetSyncLoop.ts's own polling cadence — no queue/broker for this feature either, a plain fixed-interval poll is sufficient. */
const POLL_INTERVAL_MS = 5000;

/** Same cadence/reasoning as passportWorker.ts's RECONCILE_INTERVAL_MINUTES and runSheetSyncLoop.ts's own — a crashed processor can leave a command stuck in 'processing'. */
export const RECONCILE_INTERVAL_MINUTES = 5;
const RECONCILE_INTERVAL_MS = RECONCILE_INTERVAL_MINUTES * 60_000;

export interface ReconcileStaleOperatorCommandsDependencies {
  recover: typeof recoverStaleOperatorCommands;
}

/**
 * One reconciliation pass — recovers commands abandoned by a crashed/killed
 * processor (see recoverStaleOperatorCommands's own doc comment). Same
 * convention as runSheetSyncLoop.ts's reconcileStaleSyncingJobs: logs a
 * summary only when there was something to report.
 */
export async function reconcileStaleOperatorCommands(
  deps: ReconcileStaleOperatorCommandsDependencies = { recover: recoverStaleOperatorCommands },
): Promise<void> {
  const { requeued, failed } = await deps.recover();
  if (requeued.length > 0 || failed.length > 0) {
    console.log(`[operator-command] stale-processing recovery: requeued=${requeued.length} gave-up=${failed.length}`);
  }
}

export interface RunOperatorCommandLoopDependencies {
  findPending: typeof findPendingCommands;
  processCommand: typeof processPassportOperatorCommand;
  reconcile: typeof reconcileStaleOperatorCommands;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

const defaultDependencies: RunOperatorCommandLoopDependencies = {
  findPending: findPendingCommands,
  processCommand: processPassportOperatorCommand,
  reconcile: reconcileStaleOperatorCommands,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: Date.now,
};

const PENDING_COMMANDS_LIMIT = 20;

/**
 * Polls passport_operator_commands for pending rows and processes each one
 * via processPassportOperatorCommand, which does its own atomic DB claim
 * (claimPassportOperatorCommand — pending -> processing). That single-claim
 * guarantee is what makes running two instances of this loop concurrently
 * safe, mirroring runSheetSyncLoop.ts exactly: both may see the same
 * pending command in the same poll, but only one's claim can ever succeed.
 *
 * This is the "existing sequential processing/recovery mechanism" the
 * production entry point (src/admin/operatorCommand.ts) relies on to
 * actually execute a command after insertion — the entry point itself
 * never calls processPassportOperatorCommand directly.
 *
 * `shouldContinue` lets the entrypoint request a graceful stop between
 * poll cycles, same pattern as runWorkerLoop/runSheetSyncLoop.
 */
export async function runOperatorCommandLoop(
  shouldContinue: () => boolean = () => true,
  deps: RunOperatorCommandLoopDependencies = defaultDependencies,
): Promise<void> {
  let lastReconcileAt = deps.now();

  while (shouldContinue()) {
    if (deps.now() - lastReconcileAt >= RECONCILE_INTERVAL_MS) {
      await deps.reconcile();
      lastReconcileAt = deps.now();
    }

    const pending = await deps.findPending(PENDING_COMMANDS_LIMIT);

    if (pending.length === 0) {
      await deps.sleep(POLL_INTERVAL_MS);
      continue;
    }

    for (const command of pending) {
      if (!shouldContinue()) break;
      try {
        await deps.processCommand(command.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown error';
        console.error(`[operator-command] unexpected error handling command ${command.id}: ${message}`);
      }
    }
  }
}
