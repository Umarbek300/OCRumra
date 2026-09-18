import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseEnv } from '../src/config/env.schema.js';

const VALID_BASE = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  TELEGRAM_BOT_TOKEN: '123456:TEST-token',
};

test('parseEnv accepts a valid configuration and applies defaults', () => {
  const env = parseEnv({ ...VALID_BASE });
  assert.equal(env.NODE_ENV, 'development');
  assert.equal(env.PORT, 3000);
  assert.equal(env.TELEGRAM_BOT_TOKEN, '123456:TEST-token');
});

test('parseEnv coerces PORT to a number', () => {
  const env = parseEnv({ ...VALID_BASE, PORT: '4000' });
  assert.equal(env.PORT, 4000);
});

test('parseEnv rejects a missing DATABASE_URL', () => {
  const { DATABASE_URL, ...rest } = VALID_BASE;
  assert.throws(() => parseEnv(rest));
});

test('parseEnv rejects a missing REDIS_URL', () => {
  const { REDIS_URL, ...rest } = VALID_BASE;
  assert.throws(() => parseEnv(rest));
});

test('parseEnv rejects a missing TELEGRAM_BOT_TOKEN', () => {
  const { TELEGRAM_BOT_TOKEN, ...rest } = VALID_BASE;
  assert.throws(() => parseEnv(rest));
});

test('parseEnv rejects an empty TELEGRAM_BOT_TOKEN', () => {
  assert.throws(() => parseEnv({ ...VALID_BASE, TELEGRAM_BOT_TOKEN: '' }));
});

test('parseEnv rejects an invalid NODE_ENV', () => {
  assert.throws(() => parseEnv({ ...VALID_BASE, NODE_ENV: 'staging' }));
});
