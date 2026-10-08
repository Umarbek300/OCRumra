import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseArgs } from '../src/admin/mergeIdentities.js';

test('parseArgs requires --identity-a, --identity-b, and --operator-id', () => {
  assert.throws(() => parseArgs([]));
  assert.throws(() => parseArgs(['--identity-a', 'id-1', '--identity-b', 'id-2']));
  assert.throws(() => parseArgs(['--identity-a', 'id-1', '--operator-id', 'op-1']));
  assert.throws(() => parseArgs(['--identity-b', 'id-2', '--operator-id', 'op-1']));
});

test('parseArgs returns both identity ids and operatorId when all are given', () => {
  const result = parseArgs(['--identity-a', 'id-1', '--identity-b', 'id-2', '--operator-id', 'op-1']);
  assert.deepEqual(result, { identityAId: 'id-1', identityBId: 'id-2', operatorId: 'op-1' });
});

test('parseArgs rejects identical --identity-a and --identity-b', () => {
  assert.throws(
    () => parseArgs(['--identity-a', 'id-1', '--identity-b', 'id-1', '--operator-id', 'op-1']),
    /must differ/,
  );
});

test('parseArgs throws when a flag is missing its value', () => {
  assert.throws(() => parseArgs(['--identity-a']));
});
