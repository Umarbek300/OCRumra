import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseArgs } from '../src/admin/splitLink.js';

test('parseArgs requires both --link-id and --operator-id', () => {
  assert.throws(() => parseArgs([]));
  assert.throws(() => parseArgs(['--link-id', 'link-123']));
  assert.throws(() => parseArgs(['--operator-id', 'op-1']));
});

test('parseArgs returns linkId/operatorId when both are given', () => {
  const result = parseArgs(['--link-id', 'link-123', '--operator-id', 'op-1']);
  assert.deepEqual(result, { linkId: 'link-123', operatorId: 'op-1' });
});

test('parseArgs accepts flags in either order', () => {
  const result = parseArgs(['--operator-id', 'op-1', '--link-id', 'link-123']);
  assert.deepEqual(result, { linkId: 'link-123', operatorId: 'op-1' });
});

test('parseArgs throws when a flag is missing its value', () => {
  assert.throws(() => parseArgs(['--link-id']));
});
