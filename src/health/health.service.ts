import { createClient } from 'redis';
import { env } from '../config/env.js';
import { pool } from '../db/pool.js';

export interface HealthStatus {
  status: 'ok' | 'error';
  checks: {
    database: 'ok' | 'error';
    redis: 'ok' | 'error';
  };
  timestamp: string;
}

async function checkDatabase(): Promise<'ok' | 'error'> {
  try {
    await pool.query('SELECT 1');
    return 'ok';
  } catch {
    return 'error';
  }
}

async function checkRedis(): Promise<'ok' | 'error'> {
  const client = createClient({ url: env.REDIS_URL });
  client.on('error', () => undefined);
  try {
    await client.connect();
    await client.ping();
    return 'ok';
  } catch {
    return 'error';
  } finally {
    if (client.isOpen) {
      await client.disconnect().catch(() => undefined);
    }
  }
}

export async function getHealthStatus(): Promise<HealthStatus> {
  const [database, redis] = await Promise.all([checkDatabase(), checkRedis()]);
  const overall = database === 'ok' && redis === 'ok' ? 'ok' : 'error';
  return {
    status: overall,
    checks: { database, redis },
    timestamp: new Date().toISOString(),
  };
}
