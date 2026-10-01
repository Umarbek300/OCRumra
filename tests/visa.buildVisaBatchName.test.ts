import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildVisaBatchName } from '../src/visa/buildVisaBatchName.js';

test('builds "5.10-1" from departure date 2026-10-05, batch 1', () => {
  assert.equal(buildVisaBatchName('2026-10-05', 1), '5.10-1');
});

test('builds "5.10-2" for batch 2, same departure date', () => {
  assert.equal(buildVisaBatchName('2026-10-05', 2), '5.10-2');
});

test('builds "5.10-10" for a double-digit batch number', () => {
  assert.equal(buildVisaBatchName('2026-10-05', 10), '5.10-10');
});

test('never zero-pads day or month', () => {
  assert.equal(buildVisaBatchName('2026-01-05', 1), '5.1-1');
});

test('throws a clear error on an unparseable departure date', () => {
  assert.throws(() => buildVisaBatchName('not-a-date', 1), /unparseable departure date/);
});
