import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseEnv } from '../src/config/env.schema.js';

test('parseEnv accepts a valid configuration and applies defaults', () => {
  const env = parseEnv({
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
    REDIS_URL: 'redis://localhost:6379',
  });
  assert.equal(env.NODE_ENV, 'development');
  assert.equal(env.PORT, 3000);
});

test('parseEnv coerces PORT to a number', () => {
  const env = parseEnv({
    PORT: '4000',
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
    REDIS_URL: 'redis://localhost:6379',
  });
  assert.equal(env.PORT, 4000);
});

test('parseEnv rejects a missing DATABASE_URL', () => {
  assert.throws(() =>
    parseEnv({
      REDIS_URL: 'redis://localhost:6379',
    }),
  );
});

test('parseEnv rejects a missing REDIS_URL', () => {
  assert.throws(() =>
    parseEnv({
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
    }),
  );
});

test('parseEnv rejects an invalid NODE_ENV', () => {
  assert.throws(() =>
    parseEnv({
      NODE_ENV: 'staging',
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
    }),
  );
});
