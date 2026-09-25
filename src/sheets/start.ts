import { env } from '../config/env.js';
import { pool } from '../db/pool.js';
import { reconcileStaleSyncingJobs, runSheetSyncLoop } from './runSheetSyncLoop.js';

let shuttingDown = false;

function requestShutdown(signal: string): void {
  console.log(`[sheets-sync] received ${signal}, shutting down after the current poll...`);
  shuttingDown = true;
}

process.on('SIGINT', () => requestShutdown('SIGINT'));
process.on('SIGTERM', () => requestShutdown('SIGTERM'));

/**
 * No Redis, no systemd unit yet — run manually (npm run sheets:worker) or
 * under whatever process supervisor is chosen once this stage is approved
 * for production. Starts dormant (SHEETS_SYNC_ENABLED=false by default);
 * runSheetSyncLoop itself polls that flag every cycle, so turning it on
 * takes effect without restarting this process.
 *
 * Recovers any 'syncing' row left stuck by a previous crash/restart of
 * this same worker BEFORE the first poll — mirrors worker/start.ts's own
 * upfront recoverAndRequeueStaleProcessingJobs() call. runSheetSyncLoop
 * itself repeats this same reconciliation periodically once running (see
 * its own doc comment), so this call only matters for whatever a crash
 * left behind between the last run and this one.
 */
async function main(): Promise<void> {
  console.log(
    `[sheets-sync] starting sheet-sync worker (SHEETS_SYNC_ENABLED=${env.SHEETS_SYNC_ENABLED}, no Redis involved)`,
  );
  await reconcileStaleSyncingJobs();
  await runSheetSyncLoop(() => !shuttingDown);
}

try {
  await main();
} catch (error) {
  // Fatal/systemic failure (DB unreachable, Google auth misconfigured and
  // encountered before any job-level try/catch could contain it, etc.) —
  // sanitized like every other top-level log in this codebase: a message
  // only, never a raw error object that could carry more than that.
  const message = error instanceof Error ? error.message : 'unknown error';
  console.error(`[sheets-sync] fatal error: ${message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
  console.log('[sheets-sync] shut down cleanly');
}
