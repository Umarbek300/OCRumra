import { pool } from '../db/pool.js';
import { PASSPORT_PROCESSING_QUEUE } from '../queue/passportProcessingQueue.js';
import { ensureRedisConnected, redisClient } from '../queue/redis.js';
import { runWorkerLoop } from './passportWorker.js';

let shuttingDown = false;

function requestShutdown(signal: string): void {
  console.log(`[passport-worker] received ${signal}, shutting down after the current poll...`);
  shuttingDown = true;
}

process.on('SIGINT', () => requestShutdown('SIGINT'));
process.on('SIGTERM', () => requestShutdown('SIGTERM'));

async function main(): Promise<void> {
  await ensureRedisConnected();
  console.log(`[passport-worker] connected to Redis, polling queue "${PASSPORT_PROCESSING_QUEUE}"`);
  await runWorkerLoop(() => !shuttingDown);
}

try {
  await main();
} catch (error) {
  // Sanitized like every other log in the OCR pipeline — an unexpected
  // top-level failure must not dump a raw error object that could carry
  // more than a message (stack traces are fine; arbitrary properties are not).
  const message = error instanceof Error ? error.message : 'unknown error';
  console.error(`[passport-worker] fatal error: ${message}`);
  process.exitCode = 1;
} finally {
  await redisClient.quit().catch(() => undefined);
  await pool.end();
  console.log('[passport-worker] shut down cleanly');
}
