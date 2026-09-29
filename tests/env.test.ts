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

test('parseEnv accepts OCR_PROVIDER=google-vision', () => {
  const env = parseEnv({ ...VALID_BASE, OCR_PROVIDER: 'google-vision' });
  assert.equal(env.OCR_PROVIDER, 'google-vision');
});

test('parseEnv rejects an invalid NODE_ENV', () => {
  assert.throws(() => parseEnv({ ...VALID_BASE, NODE_ENV: 'staging' }));
});

test('parseEnv defaults GOOGLE_SHEETS_API_TIMEOUT_MS to 30000', () => {
  const env = parseEnv({ ...VALID_BASE });
  assert.equal(env.GOOGLE_SHEETS_API_TIMEOUT_MS, 30_000);
});

test('parseEnv coerces a custom GOOGLE_SHEETS_API_TIMEOUT_MS to a number', () => {
  const env = parseEnv({ ...VALID_BASE, GOOGLE_SHEETS_API_TIMEOUT_MS: '5000' });
  assert.equal(env.GOOGLE_SHEETS_API_TIMEOUT_MS, 5000);
});

test('parseEnv rejects a non-positive GOOGLE_SHEETS_API_TIMEOUT_MS', () => {
  assert.throws(() => parseEnv({ ...VALID_BASE, GOOGLE_SHEETS_API_TIMEOUT_MS: '0' }));
  assert.throws(() => parseEnv({ ...VALID_BASE, GOOGLE_SHEETS_API_TIMEOUT_MS: '-1000' }));
});

test('parseEnv defaults SHEETS_SYNC_ENABLED to false when unset', () => {
  const env = parseEnv({ ...VALID_BASE });
  assert.equal(env.SHEETS_SYNC_ENABLED, false);
});

test('parseEnv parses SHEETS_SYNC_ENABLED="false" as false', () => {
  // Regression test: z.coerce.boolean() would have parsed this non-empty
  // string as `true` via JS's Boolean("false") === true — exactly the bug
  // that let this flag secretly be `true` in production despite `.env`
  // literally saying SHEETS_SYNC_ENABLED=false.
  const env = parseEnv({ ...VALID_BASE, SHEETS_SYNC_ENABLED: 'false' });
  assert.equal(env.SHEETS_SYNC_ENABLED, false);
});

test('parseEnv parses SHEETS_SYNC_ENABLED="true" as true', () => {
  const env = parseEnv({ ...VALID_BASE, SHEETS_SYNC_ENABLED: 'true' });
  assert.equal(env.SHEETS_SYNC_ENABLED, true);
});

test('parseEnv rejects an invalid SHEETS_SYNC_ENABLED value', () => {
  assert.throws(() => parseEnv({ ...VALID_BASE, SHEETS_SYNC_ENABLED: 'yes' }));
  assert.throws(() => parseEnv({ ...VALID_BASE, SHEETS_SYNC_ENABLED: 'no' }));
  assert.throws(() => parseEnv({ ...VALID_BASE, SHEETS_SYNC_ENABLED: '1' }));
  assert.throws(() => parseEnv({ ...VALID_BASE, SHEETS_SYNC_ENABLED: '0' }));
  assert.throws(() => parseEnv({ ...VALID_BASE, SHEETS_SYNC_ENABLED: 'abc' }));
});
