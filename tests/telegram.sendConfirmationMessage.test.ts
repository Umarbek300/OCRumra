import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sendConfirmationMessage } from '../src/telegram/sendConfirmationMessage.js';

test('sendConfirmationMessage calls api.sendMessage with the given chat id and text', async () => {
  const calls: Array<{ chatId: string; text: string }> = [];
  const fakeApi = {
    sendMessage: async (chatId: string | number, text: string) => {
      calls.push({ chatId: String(chatId), text });
      return {} as never;
    },
  };

  await sendConfirmationMessage('-100123', 'hello group', { api: fakeApi });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.chatId, '-100123');
  assert.equal(calls[0]!.text, 'hello group');
});

test('sendConfirmationMessage propagates a send failure to the caller (no swallowing)', async () => {
  const fakeApi = {
    sendMessage: async () => {
      throw new Error('Telegram API error: bot was blocked by the user');
    },
  };

  await assert.rejects(() => sendConfirmationMessage('-100123', 'hello group', { api: fakeApi }), /blocked by the user/);
});
