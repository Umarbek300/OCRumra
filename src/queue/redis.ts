import { createClient, type RedisClientType } from 'redis';
import { env } from '../config/env.js';

export const redisClient: RedisClientType = createClient({ url: env.REDIS_URL });

redisClient.on('error', (error) => {
  console.error('[queue] Redis client error', error);
});

let connecting: Promise<void> | null = null;

export async function ensureRedisConnected(): Promise<void> {
  if (redisClient.isOpen) return;
  if (!connecting) {
    connecting = redisClient.connect().then(() => undefined);
  }
  await connecting;
}
