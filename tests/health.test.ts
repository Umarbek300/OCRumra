import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { pool } from '../src/db/pool.js';
import { getHealthStatus } from '../src/health/health.service.js';

test('getHealthStatus reports ok when Postgres and Redis are reachable', async () => {
  const result = await getHealthStatus();
  assert.equal(result.checks.database, 'ok');
  assert.equal(result.checks.redis, 'ok');
  assert.equal(result.status, 'ok');
  assert.ok(result.timestamp);
});

after(async () => {
  await pool.end();
});
