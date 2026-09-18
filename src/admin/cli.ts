import { pool } from '../db/pool.js';
import { getDebugSnapshot } from './debug.js';

async function main(): Promise<void> {
  const snapshot = await getDebugSnapshot();
  console.log(JSON.stringify(snapshot, null, 2));
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
