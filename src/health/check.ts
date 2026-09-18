import { pool } from '../db/pool.js';
import { getHealthStatus } from './health.service.js';

async function main(): Promise<void> {
  const result = await getHealthStatus();
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.status === 'ok' ? 0 : 1;
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
