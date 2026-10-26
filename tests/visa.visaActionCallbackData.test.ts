import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildVisaActionCallbackData, parseVisaActionCallbackData } from '../src/visa/visaActionCallbackData.js';

const SAMPLE_UUID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

test('buildVisaActionCallbackData + parseVisaActionCallbackData round-trip for every action', () => {
  for (const action of ['continue', 'stop', 'check'] as const) {
    const data = buildVisaActionCallbackData(action, SAMPLE_UUID);
    assert.ok(data.length <= 64, `callback_data must fit Telegram's 64-byte limit (got ${data.length})`);
    const parsed = parseVisaActionCallbackData(data);
    assert.deepEqual(parsed, { action, visaBatchApplicantId: SAMPLE_UUID });
  }
});

test('parseVisaActionCallbackData rejects unknown action prefixes', () => {
  assert.equal(parseVisaActionCallbackData(`visa_delete:${SAMPLE_UUID}`), null);
  assert.equal(parseVisaActionCallbackData('some_unrelated_payload'), null);
  assert.equal(parseVisaActionCallbackData(''), null);
});

test('parseVisaActionCallbackData rejects a well-prefixed but malformed/non-UUID id', () => {
  assert.equal(parseVisaActionCallbackData('visa_stop:not-a-uuid'), null);
  assert.equal(parseVisaActionCallbackData('visa_stop:'), null);
  assert.equal(parseVisaActionCallbackData(`visa_stop:${SAMPLE_UUID}EXTRA`), null);
});

test('parseVisaActionCallbackData is case-insensitive for the UUID portion (Telegram-safe) but exact on the prefix', () => {
  assert.deepEqual(parseVisaActionCallbackData(`visa_check:${SAMPLE_UUID.toUpperCase()}`), {
    action: 'check',
    visaBatchApplicantId: SAMPLE_UUID.toUpperCase(),
  });
  assert.equal(parseVisaActionCallbackData(`VISA_CHECK:${SAMPLE_UUID}`), null, 'the action prefix itself must match exactly');
});
