import { Bot, InlineKeyboard, type CommandContext, type Context } from 'grammy';
import { env } from '../config/env.js';
import { evaluateDocumentUpload } from './resolveDocumentUpload.js';
import { ingestPhotoMessage } from '../telegram/ingestPhotoMessage.js';
import { removePassportCommand } from './removePassportCommand.js';
import { visaAssignCommand, type VisaAssignApplicantResult } from '../visa/visaAssignCommand.js';
import { visaSubmissionStatusCommand } from '../visa/visaSubmissionStatusCommand.js';
import { visaQueueBatchCommand } from '../visa/visaQueueBatchCommand.js';
import { visaStopApplicantCommand } from '../visa/visaStopApplicantCommand.js';
import { visaCheckAmbiguousCommand } from '../visa/visaCheckAmbiguousCommand.js';
import { resolveReplyToVisaApplicant } from '../visa/resolveReplyToVisaApplicant.js';
import { visaAttentionQueueCommand } from '../visa/visaAttentionQueueCommand.js';
import { visaContinueApplicantCommand } from '../visa/visaContinueApplicantCommand.js';
import { parseVisaActionCallbackData } from '../visa/visaActionCallbackData.js';
import { buildVisaAttentionMessage } from '../visa/visaAttentionMessage.js';
import { visaStartSubmissionCommand } from '../visa/visaStartSubmissionCommand.js';

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

// Operator-triggered VisitSaudi batch assignment for the WHOLE group (not a
// single replied-to message, unlike /remove) -- see visaAssignCommand.ts
// for the actual Sheet-read -> validate -> assignVisaBatch pipeline this
// handler only does Telegram-specific plumbing (permission check via the
// SAME creator/administrator rule /remove uses, resolving the group from
// ctx.chat.id, phrasing the per-applicant summary reply) around.
function summarizeVisaAssignResults(results: readonly VisaAssignApplicantResult[]): string {
  const assigned = results.filter((r) => r.result.status === 'ASSIGNED');
  const notReady = results.filter((r) => r.result.status === 'NOT_READY');
  const sheetIssues = results.filter((r) => r.result.status === 'SHEET_ROW_NOT_FOUND' || r.result.status === 'SHEET_READ_FAILED');
  const assignmentFailed = results.filter((r) => r.result.status === 'ASSIGNMENT_FAILED');

  const lines = [
    `Jami arizachilar: ${results.length}`,
    `✅ Batchga tayinlandi: ${assigned.length}`,
    `⏳ Hali tayyor emas: ${notReady.length}`,
  ];
  if (sheetIssues.length > 0) {
    lines.push(`⚠️ Sheet'dan o'qib bo'lmadi: ${sheetIssues.length}`);
  }
  if (assignmentFailed.length > 0) {
    lines.push(`❌ Tayinlashda xatolik: ${assignmentFailed.length}`);
  }

  if (notReady.length > 0) {
    lines.push('');
    lines.push("Tayyor emaslik sabablari:");
    for (const r of notReady) {
      if (r.result.status !== 'NOT_READY') continue;
      const detail = r.result.missingFields && r.result.missingFields.length > 0 ? r.result.missingFields.join(', ') : r.result.reason;
      lines.push(`- ${detail}`);
    }
  }

  return lines.join('\n');
}

bot.command('visa_assign', async (ctx) => {
  if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') {
    return;
  }

  if (!ctx.from) {
    await ctx.reply('Bu buyruqni anonim administrator sifatida emas, oddiy foydalanuvchi sifatida yozing.');
    return;
  }

  let authorStatus: string;
  try {
    const author = await ctx.getAuthor();
    authorStatus = author.status;
  } catch (error) {
    console.error('[bot] /visa_assign: failed to verify sender permissions', error);
    await ctx.reply("Ruxsatni tekshirishda xatolik yuz berdi, birozdan so'ng qayta urinib ko'ring.");
    return;
  }

  const outcome = await visaAssignCommand({
    telegramChatId: ctx.chat.id,
    authorStatus,
  });

  switch (outcome.kind) {
    case 'UNAUTHORIZED':
      await ctx.reply('Bu buyruqni faqat guruh administratorlari ishlata oladi.');
      return;
    case 'GROUP_NOT_FOUND':
      await ctx.reply('Bu guruh tizimda ro\'yxatdan o\'tmagan.');
      return;
    case 'EMPTY_GROUP':
      await ctx.reply('Bu guruhda hozircha birorta ham faol pasport yo\'q.');
      return;
    case 'COMPLETED':
      await ctx.reply(summarizeVisaAssignResults(outcome.results));
      return;
  }
});

function summarizeVisaSubmissionStatus(
  batchName: string,
  counts: Record<string, number>,
  conflictCount: number,
  inactivePendingCount: number,
): string {
  return [
    `VisitSaudi so'rovlar holati — ${batchName}:`,
    `Kutilmoqda (PENDING): ${counts.PENDING}`,
    `Yuborilmoqda (SUBMITTING): ${counts.SUBMITTING}`,
    `Saqlangan (SAVED): ${counts.SAVED}`,
    `Xatolik (ERROR): ${counts.ERROR}`,
    `Noaniq (AMBIGUOUS): ${counts.AMBIGUOUS}`,
    `Hal qilinmagan konfliktlar: ${conflictCount}`,
    `Faol bo'lmagan arizachiga tegishli PENDING: ${inactivePendingCount}`,
  ].join('\n');
}

// Read-only operator status view -- see visaSubmissionStatusCommand.ts's
// own doc comment. Never mutates anything (no queue/batch/portal action),
// same permission check as /visa_assign above (group/supergroup only,
// creator/administrator only).
bot.command('visa_submission_status', async (ctx) => {
  if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') {
    return;
  }

  if (!ctx.from) {
    await ctx.reply('Bu buyruqni anonim administrator sifatida emas, oddiy foydalanuvchi sifatida yozing.');
    return;
  }

  let authorStatus: string;
  try {
    const author = await ctx.getAuthor();
    authorStatus = author.status;
  } catch (error) {
    console.error('[bot] /visa_submission_status: failed to verify sender permissions', error);
    await ctx.reply("Ruxsatni tekshirishda xatolik yuz berdi, birozdan so'ng qayta urinib ko'ring.");
    return;
  }

  const outcome = await visaSubmissionStatusCommand({
    telegramChatId: ctx.chat.id,
    authorStatus,
  });

  switch (outcome.kind) {
    case 'UNAUTHORIZED':
      await ctx.reply('Bu buyruqni faqat guruh administratorlari ishlata oladi.');
      return;
    case 'GROUP_NOT_FOUND':
      await ctx.reply('Bu guruh tizimda ro\'yxatdan o\'tmagan.');
      return;
    case 'NO_BATCH':
      await ctx.reply('Bu guruh uchun hali VisitSaudi batch yaratilmagan.');
      return;
    case 'COMPLETED':
      await ctx.reply(summarizeVisaSubmissionStatus(outcome.batchName, outcome.counts, outcome.conflictCount, outcome.inactivePendingCount));
      return;
  }
});

// Queues the group's current VisitSaudi batch for submission -- see
// visaQueueBatchCommand.ts's own doc comment: this NEVER contacts the
// portal, it only creates durable PENDING queue rows (Package 1). Same
// permission check as /visa_assign and /visa_submission_status above.
bot.command('visa_queue_batch', async (ctx) => {
  if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') {
    return;
  }

  if (!ctx.from) {
    await ctx.reply('Bu buyruqni anonim administrator sifatida emas, oddiy foydalanuvchi sifatida yozing.');
    return;
  }

  let authorStatus: string;
  try {
    const author = await ctx.getAuthor();
    authorStatus = author.status;
  } catch (error) {
    console.error('[bot] /visa_queue_batch: failed to verify sender permissions', error);
    await ctx.reply("Ruxsatni tekshirishda xatolik yuz berdi, birozdan so'ng qayta urinib ko'ring.");
    return;
  }

  const operatorId = `telegram:${ctx.from.username ?? ctx.from.id}`;

  const outcome = await visaQueueBatchCommand({
    telegramChatId: ctx.chat.id,
    authorStatus,
    requestedBy: operatorId,
  });

  switch (outcome.kind) {
    case 'UNAUTHORIZED':
      await ctx.reply('Bu buyruqni faqat guruh administratorlari ishlata oladi.');
      return;
    case 'GROUP_NOT_FOUND':
      await ctx.reply('Bu guruh tizimda ro\'yxatdan o\'tmagan.');
      return;
    case 'NO_BATCH':
      await ctx.reply('Bu guruh uchun hali VisitSaudi batch yaratilmagan.');
      return;
    case 'EMPTY_BATCH':
      await ctx.reply(`"${outcome.batchName}" batchida hozircha faol ariza yo'q — navbatga qo'yish uchun hech narsa topilmadi.`);
      return;
    case 'ALREADY_QUEUED':
      await ctx.reply(`"${outcome.batchName}" allaqachon navbatga qo'yilgan — qayta navbatga qo'yilmadi.`);
      return;
    case 'QUEUED':
      await ctx.reply(`"${outcome.batchName}" navbatga qo'yildi: ${outcome.queuedCount} ta ariza. Bu hali portalga yuborilmadi.`);
      return;
  }
});

// Package 5.43, extended 5.45: starts the group's current VisitSaudi
// batch's REAL submission run (visaStartSubmissionCommand.ts) -- reuses
// startVisitSaudiBatchSubmission/runVisaWorkerLoopForBatch exactly as-is,
// never a parallel mechanism. Same permission check as the other
// VisitSaudi commands above. NO_ACTIVE_SESSION now carries its own
// specific `reason` (not configured / tunnel-Chrome unreachable /
// expected tab not found / several candidate tabs found) -- see
// visaStartSubmissionCommand.ts's own doc comment for the full CDP-tunnel
// design this command relies on.
bot.command('visa_start_submission', async (ctx) => {
  if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') {
    return;
  }

  if (!ctx.from) {
    await ctx.reply('Bu buyruqni anonim administrator sifatida emas, oddiy foydalanuvchi sifatida yozing.');
    return;
  }

  let authorStatus: string;
  try {
    const author = await ctx.getAuthor();
    authorStatus = author.status;
  } catch (error) {
    console.error('[bot] /visa_start_submission: failed to verify sender permissions', error);
    await ctx.reply("Ruxsatni tekshirishda xatolik yuz berdi, birozdan so'ng qayta urinib ko'ring.");
    return;
  }

  const operatorId = `telegram:${ctx.from.username ?? ctx.from.id}`;

  const outcome = await visaStartSubmissionCommand({
    telegramChatId: ctx.chat.id,
    authorStatus,
    requestedBy: operatorId,
  });

  switch (outcome.kind) {
    case 'UNAUTHORIZED':
      await ctx.reply('Bu buyruqni faqat guruh administratorlari ishlata oladi.');
      return;
    case 'GROUP_NOT_FOUND':
      await ctx.reply('Bu guruh tizimda ro\'yxatdan o\'tmagan.');
      return;
    case 'NO_BATCH':
      await ctx.reply('Bu guruh uchun hali VisitSaudi batch yaratilmagan.');
      return;
    case 'NOTHING_QUEUED':
      await ctx.reply(`"${outcome.batchName}" uchun navbatda hech qanday ariza yo'q -- avval /visa_queue_batch buyrug'ini ishlating.`);
      return;
    case 'NO_ACTIVE_SESSION':
      await ctx.reply(`"${outcome.batchName}" boshlanmadi: ${outcome.reason}`);
      return;
    case 'START_FAILED':
      await ctx.reply(`"${outcome.batchName}" boshlanmadi: ${outcome.detail}`);
      return;
    case 'STARTED':
      await ctx.reply(outcome.operatorSummaryText);
      return;
  }
});

/**
 * Shared reply->applicant resolution + error phrasing for /visa_stop_applicant
 * and /visa_check_ambiguous below -- both identify their target applicant
 * EXCLUSIVELY by replying to the applicant's own passport photo message,
 * same mechanism /remove already uses. See resolveReplyToVisaApplicant.ts
 * for why this is the only identification path considered safe here (no
 * guessing from text or message order). Returns null (having already
 * replied with the right error) when resolution fails, or the resolved
 * visaBatchApplicantId to proceed with.
 */
async function resolveApplicantOrReply(ctx: CommandContext<Context>): Promise<string | null> {
  const replyTo = ctx.message?.reply_to_message;
  if (!replyTo) {
    await ctx.reply("Arizaning rasm xabariga javob (reply) qilib shu buyruqni yuboring.");
    return null;
  }

  const resolution = await resolveReplyToVisaApplicant(ctx.chat.id, replyTo.message_id);
  switch (resolution.kind) {
    case 'NO_REPLY':
      await ctx.reply("Arizaning rasm xabariga javob (reply) qilib shu buyruqni yuboring.");
      return null;
    case 'MESSAGE_NOT_FOUND':
      await ctx.reply('Bu xabar tizimda topilmadi.');
      return null;
    case 'NO_ACTIVE_LINK':
      await ctx.reply("Bu xabar uchun faol pasport identifikatori topilmadi.");
      return null;
    case 'NO_BATCH_ASSIGNMENT':
      await ctx.reply('Bu ariza uchun VisitSaudi batchga tayinlash topilmadi.');
      return null;
    case 'RESOLVED':
      return resolution.visaBatchApplicantId;
  }
}

// TO'XTATISH -- stops ONE applicant's VisitSaudi submission, identified by
// replying to their passport photo message (same reply mechanism as
// /remove). See visaStopApplicantCommand.ts: reuses cancelWithConflictCheck
// entirely, never contacts the real portal, never hides a detected
// conflict. Same permission check as every other VisitSaudi command above.
bot.command('visa_stop_applicant', async (ctx) => {
  if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') {
    return;
  }

  if (!ctx.from) {
    await ctx.reply('Bu buyruqni anonim administrator sifatida emas, oddiy foydalanuvchi sifatida yozing.');
    return;
  }

  let authorStatus: string;
  try {
    const author = await ctx.getAuthor();
    authorStatus = author.status;
  } catch (error) {
    console.error('[bot] /visa_stop_applicant: failed to verify sender permissions', error);
    await ctx.reply("Ruxsatni tekshirishda xatolik yuz berdi, birozdan so'ng qayta urinib ko'ring.");
    return;
  }

  const visaBatchApplicantId = await resolveApplicantOrReply(ctx);
  if (!visaBatchApplicantId) {
    return;
  }

  const outcome = await visaStopApplicantCommand({
    telegramChatId: ctx.chat.id,
    authorStatus,
    visaBatchApplicantId,
  });

  switch (outcome.kind) {
    case 'UNAUTHORIZED':
      await ctx.reply('Bu buyruqni faqat guruh administratorlari ishlata oladi.');
      return;
    case 'GROUP_NOT_FOUND':
      await ctx.reply('Bu guruh tizimda ro\'yxatdan o\'tmagan.');
      return;
    case 'APPLICANT_NOT_FOUND':
      await ctx.reply('Bu ariza topilmadi.');
      return;
    case 'ALREADY_INACTIVE':
      await ctx.reply('Bu ariza allaqachon to\'xtatilgan.');
      return;
    case 'STOPPED':
      await ctx.reply("To'xtatildi. Hali portalga yuborilmagan edi.");
      return;
    case 'STOPPED_BUT_MAY_ALREADY_BE_SUBMITTED':
      await ctx.reply(
        "⚠️ To'xtatildi, LEKIN bu ariza portalga YUBORILGAN BO'LISHI MUMKIN edi — operator portalda qo'lda tekshirishi kerak.",
      );
      return;
  }
});

// PORTALDA TEKSHIRISH -- marks a genuinely AMBIGUOUS applicant for manual
// portal verification, identified the same reply way as above. See
// visaCheckAmbiguousCommand.ts: never changes the submission's own status
// (never auto-resubmits), only durably records that a human has been
// asked to check.
bot.command('visa_check_ambiguous', async (ctx) => {
  if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') {
    return;
  }

  if (!ctx.from) {
    await ctx.reply('Bu buyruqni anonim administrator sifatida emas, oddiy foydalanuvchi sifatida yozing.');
    return;
  }

  let authorStatus: string;
  try {
    const author = await ctx.getAuthor();
    authorStatus = author.status;
  } catch (error) {
    console.error('[bot] /visa_check_ambiguous: failed to verify sender permissions', error);
    await ctx.reply("Ruxsatni tekshirishda xatolik yuz berdi, birozdan so'ng qayta urinib ko'ring.");
    return;
  }

  const visaBatchApplicantId = await resolveApplicantOrReply(ctx);
  if (!visaBatchApplicantId) {
    return;
  }

  const outcome = await visaCheckAmbiguousCommand({
    telegramChatId: ctx.chat.id,
    authorStatus,
    visaBatchApplicantId,
  });

  switch (outcome.kind) {
    case 'UNAUTHORIZED':
      await ctx.reply('Bu buyruqni faqat guruh administratorlari ishlata oladi.');
      return;
    case 'GROUP_NOT_FOUND':
      await ctx.reply('Bu guruh tizimda ro\'yxatdan o\'tmagan.');
      return;
    case 'APPLICANT_NOT_FOUND':
      await ctx.reply('Bu ariza topilmadi.');
      return;
    case 'NO_QUEUE_RECORD':
      await ctx.reply('Bu ariza hali navbatga qo\'yilmagan — tekshirish uchun hech narsa yo\'q.');
      return;
    case 'NOT_AMBIGUOUS':
      await ctx.reply('Bu ariza hozircha noaniq (AMBIGUOUS) holatda emas.');
      return;
    case 'FLAGGED_FOR_REVIEW':
      await ctx.reply("Qabul qilindi — bu ariza portalda qo'lda tekshirilishi kerak deb belgilandi.");
      return;
    case 'ALREADY_FLAGGED':
      await ctx.reply("Bu ariza allaqachon portalda tekshirish uchun belgilangan.");
      return;
  }
});

// Read-only: lists the group's current VisitSaudi batch items that need an
// operator decision, one Telegram message per item, each with the three
// standard action buttons attached. See visaAttentionQueueCommand.ts --
// never writes anything, never contacts the portal. Same permission check
// as every other VisitSaudi command above.
bot.command('visa_attention_queue', async (ctx) => {
  if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') {
    return;
  }

  if (!ctx.from) {
    await ctx.reply('Bu buyruqni anonim administrator sifatida emas, oddiy foydalanuvchi sifatida yozing.');
    return;
  }

  let authorStatus: string;
  try {
    const author = await ctx.getAuthor();
    authorStatus = author.status;
  } catch (error) {
    console.error('[bot] /visa_attention_queue: failed to verify sender permissions', error);
    await ctx.reply("Ruxsatni tekshirishda xatolik yuz berdi, birozdan so'ng qayta urinib ko'ring.");
    return;
  }

  const outcome = await visaAttentionQueueCommand({ telegramChatId: ctx.chat.id, authorStatus });

  switch (outcome.kind) {
    case 'UNAUTHORIZED':
      await ctx.reply('Bu buyruqni faqat guruh administratorlari ishlata oladi.');
      return;
    case 'GROUP_NOT_FOUND':
      await ctx.reply('Bu guruh tizimda ro\'yxatdan o\'tmagan.');
      return;
    case 'NO_BATCH':
      await ctx.reply('Bu guruh uchun hali VisitSaudi batch yaratilmagan.');
      return;
    case 'COMPLETED':
      if (outcome.items.length === 0) {
        await ctx.reply(`"${outcome.batchName}" — hozircha operator e'tiborini talab qiladigan ariza yo'q.`);
        return;
      }
      for (const item of outcome.items) {
        const message = buildVisaAttentionMessage(outcome.groupName, outcome.batchName, item);
        await ctx.reply(message.text, { reply_markup: message.keyboard });
      }
      return;
  }
});

// Single handler for all three action buttons (DAVOM ETISH / TO'XTATISH /
// PORTALDA TEKSHIRISH) attached by /visa_attention_queue above. Every
// check below is re-derived FRESH from the live callback's own chat and
// sender -- nothing is trusted from callback_data except the applicant id
// it names, and that id is independently re-verified (group ownership,
// current status) by the command-core functions themselves, exactly as
// for the text-based /visa_stop_applicant and /visa_check_ambiguous
// commands. A malformed/forged callback_data is rejected by
// parseVisaActionCallbackData before any of that even runs.
bot.callbackQuery(/^visa_(continue|stop|check):/, async (ctx) => {
  const data = ctx.callbackQuery.data;
  const parsed = data ? parseVisaActionCallbackData(data) : null;
  if (!parsed) {
    await ctx.answerCallbackQuery({ text: "Yaroqsiz amal.", show_alert: true });
    return;
  }

  if (ctx.chat?.type !== 'group' && ctx.chat?.type !== 'supergroup') {
    await ctx.answerCallbackQuery({ text: 'Bu amal faqat guruhda ishlaydi.', show_alert: true });
    return;
  }

  if (!ctx.from) {
    await ctx.answerCallbackQuery({ text: "Ruxsatni tekshirib bo'lmadi.", show_alert: true });
    return;
  }

  let authorStatus: string;
  try {
    const author = await ctx.getAuthor();
    authorStatus = author.status;
  } catch (error) {
    console.error(`[bot] visa action callback (${parsed.action}): failed to verify sender permissions`, error);
    await ctx.answerCallbackQuery({ text: "Ruxsatni tekshirishda xatolik yuz berdi.", show_alert: true });
    return;
  }

  if (parsed.action === 'continue') {
    const outcome = await visaContinueApplicantCommand({
      telegramChatId: ctx.chat.id,
      authorStatus,
      visaBatchApplicantId: parsed.visaBatchApplicantId,
    });
    const text =
      outcome.kind === 'UNAUTHORIZED'
        ? 'Bu amalni faqat guruh administratorlari bajara oladi.'
        : outcome.kind === 'GROUP_NOT_FOUND'
          ? "Bu guruh tizimda ro'yxatdan o'tmagan."
          : outcome.kind === 'APPLICANT_NOT_FOUND'
            ? 'Bu ariza topilmadi.'
            : "⏳ Portalga avtomatik yuborish hali tayyor emas — bu funksiya keyinroq ishga tushiriladi.";
    await ctx.answerCallbackQuery({ text, show_alert: true });
    return;
  }

  if (parsed.action === 'stop') {
    const outcome = await visaStopApplicantCommand({
      telegramChatId: ctx.chat.id,
      authorStatus,
      visaBatchApplicantId: parsed.visaBatchApplicantId,
    });
    const text =
      outcome.kind === 'UNAUTHORIZED'
        ? 'Bu amalni faqat guruh administratorlari bajara oladi.'
        : outcome.kind === 'GROUP_NOT_FOUND'
          ? "Bu guruh tizimda ro'yxatdan o'tmagan."
          : outcome.kind === 'APPLICANT_NOT_FOUND'
            ? 'Bu ariza topilmadi.'
            : outcome.kind === 'ALREADY_INACTIVE'
              ? "Bu ariza allaqachon to'xtatilgan."
              : outcome.kind === 'STOPPED'
                ? "To'xtatildi. Hali portalga yuborilmagan edi."
                : "⚠️ To'xtatildi, LEKIN bu ariza portalga YUBORILGAN BO'LISHI MUMKIN edi — operator portalda qo'lda tekshirishi kerak.";
    await ctx.answerCallbackQuery({ text, show_alert: true });
    return;
  }

  // parsed.action === 'check'
  const outcome = await visaCheckAmbiguousCommand({
    telegramChatId: ctx.chat.id,
    authorStatus,
    visaBatchApplicantId: parsed.visaBatchApplicantId,
  });
  const text =
    outcome.kind === 'UNAUTHORIZED'
      ? 'Bu amalni faqat guruh administratorlari bajara oladi.'
      : outcome.kind === 'GROUP_NOT_FOUND'
        ? "Bu guruh tizimda ro'yxatdan o'tmagan."
        : outcome.kind === 'APPLICANT_NOT_FOUND'
          ? 'Bu ariza topilmadi.'
          : outcome.kind === 'NO_QUEUE_RECORD'
            ? "Bu ariza hali navbatga qo'yilmagan."
            : outcome.kind === 'NOT_AMBIGUOUS'
              ? 'Bu ariza hozircha noaniq (AMBIGUOUS) holatda emas.'
              : outcome.kind === 'FLAGGED_FOR_REVIEW'
                ? "Qabul qilindi — bu ariza portalda qo'lda tekshirilishi kerak deb belgilandi."
                : "Bu ariza allaqachon portalda tekshirish uchun belgilangan.";
  await ctx.answerCallbackQuery({ text, show_alert: true });
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
