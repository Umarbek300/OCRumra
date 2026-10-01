import { Bot } from 'grammy';
import { env } from '../config/env.js';
import { evaluateDocumentUpload } from './resolveDocumentUpload.js';
import { ingestPhotoMessage } from '../telegram/ingestPhotoMessage.js';
import { removePassportCommand } from './removePassportCommand.js';

export const bot = new Bot(env.TELEGRAM_BOT_TOKEN);

function getSenderDisplayName(from: { first_name: string; last_name?: string; username?: string }): string | null {
  const fullName = [from.first_name, from.last_name].filter(Boolean).join(' ').trim();
  return fullName || from.username || null;
}

// Debug helper only — commands are always delivered to bots regardless of
// privacy mode, so this works to discover ids before privacy mode is
// disabled. Not part of the passport-photo pipeline.
bot.command('whoami', async (ctx) => {
  const chatId = ctx.chat.id;
  const senderId = ctx.from?.id ?? null;
  const displayName = ctx.from ? getSenderDisplayName(ctx.from) : null;

  await ctx.reply(
    [
      `Chat ID: ${chatId} (${ctx.chat.type})`,
      `Your Telegram user ID: ${senderId ?? 'unknown'}`,
      `Display name: ${displayName ?? 'unknown'}`,
    ].join('\n'),
  );
});

// The practical equivalent of "deleting the Telegram message" for removing
// a passport from its group's Sheet — Telegram's Bot API has no
// message-deletion event for ordinary group/supergroup chats (see
// migrations/0020_create_passport_operator_commands.sql's own doc comment),
// so an operator replies "/remove" to the passport photo instead. See
// removePassportCommand.ts for the actual resolution/domain logic; this
// handler only does Telegram-specific plumbing (permission check, parsing
// the reply, phrasing the response).
bot.command('remove', async (ctx) => {
  if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') {
    return;
  }

  if (!ctx.from) {
    await ctx.reply('Bu buyruqni anonim administrator sifatida emas, oddiy foydalanuvchi sifatida yozing.');
    return;
  }

  const replyTo = ctx.message?.reply_to_message;
  if (!replyTo) {
    await ctx.reply("Pasport rasmiga javob (reply) qilib /remove deb yozing.");
    return;
  }

  let authorStatus: string;
  try {
    const author = await ctx.getAuthor();
    authorStatus = author.status;
  } catch (error) {
    console.error('[bot] /remove: failed to verify sender permissions', error);
    await ctx.reply("Ruxsatni tekshirishda xatolik yuz berdi, birozdan so'ng qayta urinib ko'ring.");
    return;
  }

  if (authorStatus !== 'creator' && authorStatus !== 'administrator') {
    await ctx.reply('Bu buyruqni faqat guruh administratorlari ishlata oladi.');
    return;
  }

  const operatorId = `telegram:${ctx.from.username ?? ctx.from.id}`;

  const outcome = await removePassportCommand({
    telegramChatId: ctx.chat.id,
    telegramMessageId: replyTo.message_id,
    operatorId,
  });

  switch (outcome.kind) {
    case 'MESSAGE_NOT_FOUND':
      await ctx.reply('Bu xabar tizimda topilmadi (pasport rasmi sifatida qayd etilmagan).');
      return;
    case 'NOT_A_PASSPORT_MESSAGE':
      await ctx.reply("Bu xabarda pasport ma'lumotlari aniqlanmagan.");
      return;
    case 'ALREADY_REMOVED':
      await ctx.reply('Bu pasport allaqachon shu guruhdan olib tashlangan.');
      return;
    case 'SUBMITTED':
      await ctx.reply(
        outcome.alreadyPending
          ? "Bu pasportni olib tashlash buyrug'i allaqachon navbatda."
          : "✅ Qabul qilindi — pasport bir necha soniyada shu guruh jadvalidan olib tashlanadi.",
      );
      return;
  }
});

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
    source: 'photo',
    captionText: ctx.message.caption ?? null,
    mediaGroupId: ctx.message.media_group_id ?? null,
    chatTitle: ctx.chat.title,
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

// Recovers full-resolution passport photos: Telegram's "photo" upload path
// (above) always re-compresses and caps images at ~1280px on the long
// edge, which root-cause diagnostics showed can be enough on its own to
// break MRZ OCR. A passport sent as a File/Document instead skips that
// compression pipeline entirely. Purely additive - the message:photo
// handler above is untouched.
bot.on('message:document', async (ctx) => {
  if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') {
    return;
  }

  if (!ctx.from) {
    console.warn(
      `Ignoring document message with no identifiable sender: chat=${ctx.chat.id} message=${ctx.message.message_id}`,
    );
    return;
  }

  const document = ctx.message.document;
  const decision = evaluateDocumentUpload({ mimeType: document.mime_type, fileSize: document.file_size });
  if (!decision.accepted) {
    // Never logs document.file_name (arbitrary user-controlled text) - only
    // the coarse, non-PII rejection reason.
    console.warn(
      `Ignoring document message: chat=${ctx.chat.id} message=${ctx.message.message_id} reason=${decision.reason}`,
    );
    return;
  }

  const result = await ingestPhotoMessage({
    chatId: ctx.chat.id,
    messageId: ctx.message.message_id,
    senderUserId: ctx.from.id,
    senderDisplayName: getSenderDisplayName(ctx.from),
    timestamp: new Date(ctx.message.date * 1000),
    photoFileId: document.file_id,
    source: 'document',
    captionText: ctx.message.caption ?? null,
    mediaGroupId: ctx.message.media_group_id ?? null,
    chatTitle: ctx.chat.title,
  });

  if (result.outcome === 'duplicate') {
    console.log(
      `Duplicate document message ignored: chat=${ctx.chat.id} message=${ctx.message.message_id}`,
    );
    return;
  }

  if (!result.groupLinked || !result.agentLinked) {
    console.warn(
      `Unlinked document message recorded: chat=${ctx.chat.id} message=${ctx.message.message_id} ` +
        `groupLinked=${result.groupLinked} agentLinked=${result.agentLinked}`,
    );
    return;
  }

  console.log(`Document message linked and recorded: chat=${ctx.chat.id} message=${ctx.message.message_id}`);
});

bot.catch((error) => {
  console.error('Telegram bot error', error);
});
