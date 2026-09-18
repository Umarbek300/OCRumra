import { Bot } from 'grammy';
import { env } from '../config/env.js';
import { ingestPhotoMessage } from '../telegram/ingestPhotoMessage.js';

export const bot = new Bot(env.TELEGRAM_BOT_TOKEN);

function getSenderDisplayName(from: { first_name: string; last_name?: string; username?: string }): string | null {
  const fullName = [from.first_name, from.last_name].filter(Boolean).join(' ').trim();
  return fullName || from.username || null;
}

bot.on('message:photo', async (ctx) => {
  // Only group/supergroup chats map to a customer Group; ignore DMs and channels.
  if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') {
    return;
  }

  // Anonymous senders (e.g. "send as channel") carry no per-user id and
  // cannot be attributed to an Agent, so there is nothing safe to record.
  if (!ctx.from) {
    console.warn(
      `Ignoring photo message with no identifiable sender: chat=${ctx.chat.id} message=${ctx.message.message_id}`,
    );
    return;
  }

  const largestPhoto = ctx.message.photo.at(-1);
  if (!largestPhoto) {
    return;
  }

  const result = await ingestPhotoMessage({
    chatId: ctx.chat.id,
    messageId: ctx.message.message_id,
    senderUserId: ctx.from.id,
    senderDisplayName: getSenderDisplayName(ctx.from),
    timestamp: new Date(ctx.message.date * 1000),
    photoFileId: largestPhoto.file_id,
  });

  if (result.outcome === 'duplicate') {
    console.log(
      `Duplicate photo message ignored: chat=${ctx.chat.id} message=${ctx.message.message_id}`,
    );
    return;
  }

  if (!result.groupLinked || !result.agentLinked) {
    console.warn(
      `Unlinked photo message recorded: chat=${ctx.chat.id} message=${ctx.message.message_id} ` +
        `groupLinked=${result.groupLinked} agentLinked=${result.agentLinked}`,
    );
    return;
  }

  console.log(`Photo message linked and recorded: chat=${ctx.chat.id} message=${ctx.message.message_id}`);
});

bot.catch((error) => {
  console.error('Telegram bot error', error);
});
