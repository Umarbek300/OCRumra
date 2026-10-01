import { pool } from '../db/pool.js';

/**
 * Phase 1 entrypoint placeholder for the eventual visa-automation worker.
 * Deliberately does nothing but start up and shut down cleanly right now --
 * no polling loop, no browser automation, no portal connection exists in
 * this phase (see visitSaudiAutomation.ts's own doc comment). Reserved so
 * `npm run visa:worker` already exists under the same process-per-worker
 * convention as sheets:worker/operator-command:worker, ready for Phase 2 to
 * fill in without inventing a new entrypoint shape.
 */
async function main(): Promise<void> {
  console.log('[visa] worker placeholder started -- no automation implemented in Phase 1');
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
