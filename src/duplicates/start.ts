import { pool } from '../db/pool.js';
import { reconcileStaleOperatorCommands, runOperatorCommandLoop } from './runOperatorCommandLoop.js';

let shuttingDown = false;

function requestShutdown(signal: string): void {
  console.log(`[operator-command] received ${signal}, shutting down after the current poll...`);
  shuttingDown = true;
}

process.on('SIGINT', () => requestShutdown('SIGINT'));
process.on('SIGTERM', () => requestShutdown('SIGTERM'));

/**
 * No Redis, no systemd unit yet — run manually (npm run operator-command:worker)
 * or under whatever process supervisor is chosen once this stage is approved
 * for production. Mirrors sheets/start.ts exactly: reconciles any command
 * left stuck in 'processing' by a previous crash BEFORE the first poll,
 * then hands off to the loop's own periodic reconciliation.
 */
async function main(): Promise<void> {
  console.log('[operator-command] starting operator-command worker');
  await reconcileStaleOperatorCommands();
  await runOperatorCommandLoop(() => !shuttingDown);
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : 'unknown error';
  console.error(`[operator-command] fatal error: ${message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
  console.log('[operator-command] shut down cleanly');
}
