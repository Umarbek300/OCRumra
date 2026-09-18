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
  console.error('[passport-worker] fatal error', error);
  process.exitCode = 1;
} finally {
  await redisClient.quit().catch(() => undefined);
  await pool.end();
  console.log('[passport-worker] shut down cleanly');
}
