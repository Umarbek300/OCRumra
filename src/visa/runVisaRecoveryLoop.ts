import {
  recoverStaleBatchLocks,
  recoverStaleSubmittingToAmbiguous,
  type RecoverStaleSubmittingResult,
} from './visaSubmissionQueueOrchestrator.js';
import { buildPostgresVisaBatchLockStore, buildPostgresVisaSubmissionQueueStore } from './visaSubmissionQueuePostgresStore.js';
import type { VisaBatchLockStore, VisaSubmissionQueueStore } from './visaSubmissionQueueStore.js';

/**
 * No Redis, no automation, no claim/finalize call anywhere in this file --
 * recoverStaleSubmittingToAmbiguous and recoverStaleBatchLocks are the ONLY
 * two functions this loop ever calls (see their own doc comments in
 * visaSubmissionQueueOrchestrator.ts): one moves an abandoned SUBMITTING
 * row to AMBIGUOUS, the other force-releases an abandoned batch lock.
 * Neither submits, claims, or finalizes anything, and neither this file nor
 * anything it imports references visitSaudiAutomation.ts,
 * visaApplicantAutomationAdapter.ts, mockVisaApplicantAutomationAdapter.ts,
 * or visaWorkerLoop.ts -- confirmed by this file's own import list.
 *
 * Same fixed-interval, single while-loop shape as
 * sheets/runSheetSyncLoop.ts: the next cycle's work only ever starts after
 * the previous cycle's awaits have all resolved, so there is no
 * setInterval-style re-entrancy risk and no need for a separate
 * "already running" guard -- overlapping cycles are structurally
 * impossible by construction, not merely discouraged.
 */
export const POLL_INTERVAL_MS = 60_000;

export interface RunVisaRecoveryLoopDependencies {
  queueStore: VisaSubmissionQueueStore;
  lockStore: VisaBatchLockStore;
  recoverSubmitting: typeof recoverStaleSubmittingToAmbiguous;
  recoverLocks: typeof recoverStaleBatchLocks;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

/**
 * Package 5.19: deliberately a FUNCTION, not a module-level const. A
 * default-parameter expression (see runVisaRecoveryLoop below) is only
 * ever evaluated at CALL time, never merely by importing this module --
 * so neither Postgres store is constructed just because start.ts has a
 * static `import { runVisaRecoveryLoop } from './runVisaRecoveryLoop.js'`
 * at its top. (Package 5.18's audit found the PREVIOUS shape -- a
 * top-level `const defaultDependencies = { queueStore:
 * buildPostgresVisaSubmissionQueueStore(), ... }` -- called both builders
 * eagerly at import time regardless of VISA_RECOVERY_ENABLED; harmless in
 * practice, since both builders are pure/zero-I/O, but it contradicted
 * this file's and start.ts's own doc comments, which claimed otherwise.)
 */
function buildDefaultDependencies(): RunVisaRecoveryLoopDependencies {
  return {
    queueStore: buildPostgresVisaSubmissionQueueStore(),
    lockStore: buildPostgresVisaBatchLockStore(),
    recoverSubmitting: recoverStaleSubmittingToAmbiguous,
    recoverLocks: recoverStaleBatchLocks,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
  };
}

function summarizeSubmittingRecovery(result: RecoverStaleSubmittingResult): string | null {
  if (result.movedToAmbiguous.length === 0 && result.lostRaceAgainstFinish.length === 0 && result.unexpectedFailures.length === 0) {
    return null;
  }
  return (
    `movedToAmbiguous=${result.movedToAmbiguous.length} ` +
    `lostRaceAgainstFinish=${result.lostRaceAgainstFinish.length} ` +
    `unexpectedFailures=${result.unexpectedFailures.length}`
  );
}

/**
 * One recovery pass: sweeps stale SUBMITTING records to AMBIGUOUS, then
 * force-releases stale batch locks. The two calls are independent (neither
 * depends on the other's outcome) and each gets its OWN try/catch -- a
 * transient failure in one (e.g. the DB briefly unreachable) is logged and
 * never prevents the other from running this cycle or any future cycle
 * from running at all. Mirrors reconcileStaleSyncingJobs's own "only log
 * when there was something to report" convention.
 */
async function runOneRecoveryPass(deps: RunVisaRecoveryLoopDependencies): Promise<void> {
  try {
    const submittingResult = await deps.recoverSubmitting(deps.queueStore, deps.now());
    const summary = summarizeSubmittingRecovery(submittingResult);
    if (summary) {
      console.log(`[visa-recovery] stale-submitting sweep: ${summary}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    console.error(`[visa-recovery] stale-submitting sweep failed: ${message}`);
  }

  try {
    const lockResult = await deps.recoverLocks(deps.lockStore, deps.now());
    if (lockResult.released.length > 0 || lockResult.alreadyChanged.length > 0 || lockResult.unexpectedFailures.length > 0) {
      console.log(
        `[visa-recovery] stale-lock sweep: released=${lockResult.released.length} alreadyChanged=${lockResult.alreadyChanged.length} unexpectedFailures=${lockResult.unexpectedFailures.length}`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    console.error(`[visa-recovery] stale-lock sweep failed: ${message}`);
  }
}

/**
 * `shouldContinue` lets the entrypoint (start.ts) request a graceful stop
 * between cycles -- same pattern runSheetSyncLoop.ts already uses for the
 * same purpose. This function assumes enablement was already decided by
 * the caller (see start.ts: when VISA_RECOVERY_ENABLED is false, this
 * function is never called at all) -- it carries no enabled/disabled
 * check of its own, since recovery has no "mid-run" state that would ever
 * need live toggling (see VISA_RECOVERY_ENABLED's own doc comment in
 * env.schema.ts).
 */
export async function runVisaRecoveryLoop(
  shouldContinue: () => boolean = () => true,
  deps: RunVisaRecoveryLoopDependencies = buildDefaultDependencies(),
): Promise<void> {
  while (shouldContinue()) {
    await runOneRecoveryPass(deps);
    await deps.sleep(POLL_INTERVAL_MS);
  }
}
