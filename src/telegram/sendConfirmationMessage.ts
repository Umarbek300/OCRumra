import { Api } from 'grammy';
import { env } from '../config/env.js';

let telegramSendApi: Api | null = null;

function getTelegramSendApi(): Api {
  if (!telegramSendApi) {
    telegramSendApi = new Api(env.TELEGRAM_BOT_TOKEN);
  }
  return telegramSendApi;
}

export interface SendConfirmationMessageOptions {
  /** Injectable for tests — defaults to a lazily-created grammY Api client using TELEGRAM_BOT_TOKEN, same pattern as downloadTelegramPhoto.ts. */
  api?: Pick<Api, 'sendMessage'>;
}

/**
 * Sends the post-sync confirmation text to the group the passport photo
 * itself came from (telegramChatId), independent of the bot's own polling
 * process — this runs from the standalone sheets-sync worker, which never
 * starts a Bot/polling instance. Throws on failure; the caller
 * (syncPassportRowToSheet.ts) decides how to handle that without ever
 * letting it look like the Sheets sync itself failed.
 */
export async function sendConfirmationMessage(
  telegramChatId: string,
  text: string,
  options: SendConfirmationMessageOptions = {},
): Promise<void> {
  const api = options.api ?? getTelegramSendApi();
  await api.sendMessage(telegramChatId, text);
}
