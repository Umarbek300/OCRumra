import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectProvider } from '../src/ocr/providers/index.js';

test('selectProvider("anthropic") returns the anthropic provider', () => {
  assert.equal(selectProvider('anthropic').name, 'anthropic');
});

test('selectProvider("local") returns the local provider', () => {
  assert.equal(selectProvider('local').name, 'local');
});

test('selectProvider("compare") returns a provider named "local" (local is authoritative in compare mode)', () => {
  assert.equal(selectProvider('compare').name, 'local');
});
