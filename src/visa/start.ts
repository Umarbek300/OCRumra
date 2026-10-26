import { env } from '../config/env.js';
import { pool } from '../db/pool.js';
import { runVisaRecoveryLoop } from './runVisaRecoveryLoop.js';

let shuttingDown = false;

function requestShutdown(signal: string): void {
  console.log(`[visa] received ${signal}, shutting down after the current recovery cycle...`);
  shuttingDown = true;
}

process.on('SIGINT', () => requestShutdown('SIGINT'));
process.on('SIGTERM', () => requestShutdown('SIGTERM'));

/**
 * Phase 1 entrypoint for the eventual visa-automation worker. Still no
 * browser automation, no portal connection, no claim/finalize call
 * anywhere in this process (see visitSaudiAutomation.ts's own doc
 * comment) -- Package 5.17 wires ONLY the stale-record recovery loop
 * (runVisaRecoveryLoop.ts), which never submits, claims, or finalizes
 * anything.
 *
 * Package 5.17 deliberately makes no production-enablement decision:
 * VISA_RECOVERY_ENABLED defaults to false (env.schema.ts), so this worker
 * ships dormant. When disabled, this function returns immediately after
 * logging, exactly like the original Phase 1 placeholder did, so
 * `npm run visa:worker` remains safe to start in any environment without
 * opt-in -- runVisaRecoveryLoop is never even CALLED, and (Package 5.19:
 * see buildDefaultDependencies's own doc comment in runVisaRecoveryLoop.ts)
 * neither Postgres store it would otherwise build is constructed either,
 * since that construction only ever happens as a default-parameter
 * expression evaluated at CALL time -- never merely by this file's own
 * static import of runVisaRecoveryLoop.ts above.
 */
async function main(): Promise<void> {
  if (!env.VISA_RECOVERY_ENABLED) {
    console.log('[visa] recovery disabled (VISA_RECOVERY_ENABLED is not "true") -- exiting cleanly without running recovery');
    return;
  }

  console.log('[visa] starting stale-record recovery loop (VISA_RECOVERY_ENABLED=true)');
  await runVisaRecoveryLoop(() => !shuttingDown);
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : 'unknown error';
  console.error(`[visa] fatal error: ${message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
  console.log('[visa] shut down cleanly');
}
