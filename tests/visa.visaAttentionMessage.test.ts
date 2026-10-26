import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AttentionNeededRecord } from '../src/db/repositories/visaSubmissionQueue.repo.js';
import { parseVisaActionCallbackData } from '../src/visa/visaActionCallbackData.js';
import { buildVisaAttentionKeyboard, buildVisaAttentionMessage, visaAttentionReasonText } from '../src/visa/visaAttentionMessage.js';

const ITEM_A: AttentionNeededRecord = {
  queueId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
  visaBatchApplicantId: '11111111-1111-1111-1111-111111111111',
  status: 'SUBMITTING',
  positionInBatch: 3,
};

const ITEM_B: AttentionNeededRecord = {
  queueId: '4fa85f64-5717-4562-b3fc-2c963f66afa7',
  visaBatchApplicantId: '22222222-2222-2222-2222-222222222222',
  status: 'AMBIGUOUS',
  positionInBatch: 7,
};

test('visaAttentionReasonText: distinct, human-readable reasons for SUBMITTING (conflict) vs AMBIGUOUS', () => {
  const submittingReason = visaAttentionReasonText('SUBMITTING');
  const ambiguousReason = visaAttentionReasonText('AMBIGUOUS');
  assert.notEqual(submittingReason, ambiguousReason);
  assert.match(submittingReason, /konflikt/i);
  assert.match(ambiguousReason, /noaniq/i);
});

test('buildVisaAttentionKeyboard: all three buttons encode the SAME applicant id passed in', () => {
  const keyboard = buildVisaAttentionKeyboard(ITEM_A.visaBatchApplicantId);
  const buttons = keyboard.inline_keyboard.flat();
  assert.equal(buttons.length, 3);

  const parsedActions = new Set<string>();
  for (const button of buttons) {
    assert.ok('callback_data' in button && button.callback_data);
    const parsed = parseVisaActionCallbackData(button.callback_data as string);
    assert.ok(parsed, `button callback_data must parse: ${button.callback_data}`);
    assert.equal(parsed!.visaBatchApplicantId, ITEM_A.visaBatchApplicantId);
    parsedActions.add(parsed!.action);
  }
  assert.deepEqual(parsedActions, new Set(['continue', 'stop', 'check']));
});

test('buildVisaAttentionMessage: message text reflects group/batch/position/status/reason for that one item', () => {
  const message = buildVisaAttentionMessage('Test Group', 'Batch #1', ITEM_A);
  assert.match(message.text, /Test Group/);
  assert.match(message.text, /Batch #1/);
  assert.match(message.text, /3-o'rin/);
  assert.match(message.text, /SUBMITTING/);
  assert.match(message.text, new RegExp(visaAttentionReasonText('SUBMITTING').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('buildVisaAttentionMessage: two different items in the same batch never mix up their own applicant id in the keyboard', () => {
  const messageA = buildVisaAttentionMessage('Group', 'Batch', ITEM_A);
  const messageB = buildVisaAttentionMessage('Group', 'Batch', ITEM_B);

  const buttonsA = messageA.keyboard.inline_keyboard.flat();
  const buttonsB = messageB.keyboard.inline_keyboard.flat();

  for (const button of buttonsA) {
    assert.ok('callback_data' in button && button.callback_data);
    const parsed = parseVisaActionCallbackData(button.callback_data);
    assert.equal(parsed!.visaBatchApplicantId, ITEM_A.visaBatchApplicantId);
    assert.notEqual(parsed!.visaBatchApplicantId, ITEM_B.visaBatchApplicantId);
  }
  for (const button of buttonsB) {
    assert.ok('callback_data' in button && button.callback_data);
    const parsed = parseVisaActionCallbackData(button.callback_data);
    assert.equal(parsed!.visaBatchApplicantId, ITEM_B.visaBatchApplicantId);
    assert.notEqual(parsed!.visaBatchApplicantId, ITEM_A.visaBatchApplicantId);
  }

  // The two items' own text also stays distinct (position + status differ).
  assert.notEqual(messageA.text, messageB.text);
  assert.match(messageA.text, /3-o'rin/);
  assert.match(messageB.text, /7-o'rin/);
});
