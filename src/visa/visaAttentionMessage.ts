import { InlineKeyboard } from 'grammy';
import type { AttentionNeededRecord } from '../db/repositories/visaSubmissionQueue.repo.js';
import { buildVisaActionCallbackData } from './visaActionCallbackData.js';

/**
 * Pure (Telegram-call-free) message/keyboard builder for one
 * /visa_attention_queue item -- extracted out of bot.ts specifically so
 * the binding between an item's own applicant id and its own three
 * buttons' callback_data can be unit-tested directly, without mocking
 * grammy's Context (which this codebase's own convention never does --
 * see every other VisitSaudi bot.ts handler, none of which is tested at
 * the bot.ts layer itself).
 */
export function visaAttentionReasonText(status: AttentionNeededRecord['status']): string {
  if (status === 'SUBMITTING') {
    return "bekor qilish paytida konflikt aniqlandi — bu ariza portalga YUBORILGAN BO'LISHI MUMKIN";
  }
  if (status === 'AMBIGUOUS') {
    return "portal natijasi noaniq — operator portalda qo'lda tekshirishi kerak";
  }
  return "operator e'tibori talab qilinadi";
}

export function buildVisaAttentionKeyboard(visaBatchApplicantId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('DAVOM ETISH', buildVisaActionCallbackData('continue', visaBatchApplicantId))
    .text("TO'XTATISH", buildVisaActionCallbackData('stop', visaBatchApplicantId))
    .text('PORTALDA TEKSHIRISH', buildVisaActionCallbackData('check', visaBatchApplicantId));
}

export interface VisaAttentionMessage {
  text: string;
  keyboard: InlineKeyboard;
}

/**
 * Builds the full text + keyboard for ONE attention item -- the group
 * name, batch name, and applicant's own position_in_batch (a safe,
 * already-exposed identifier; never a guessed or invented personal name)
 * are all taken directly from the already-resolved outcome, never
 * re-derived or guessed here. The keyboard's three buttons all encode
 * THIS item's own visaBatchApplicantId -- never any other item's, even
 * when this is called in a loop over several items in the same batch
 * (see this module's own test for a direct proof of that non-mixing).
 */
export function buildVisaAttentionMessage(groupName: string, batchName: string, item: AttentionNeededRecord): VisaAttentionMessage {
  const text = [
    `Guruh: ${groupName}`,
    `Batch: ${batchName}`,
    `Ariza: ${item.positionInBatch}-o'rin`,
    `Holat: ${item.status}`,
    `Sabab: ${visaAttentionReasonText(item.status)}`,
  ].join('\n');

  return { text, keyboard: buildVisaAttentionKeyboard(item.visaBatchApplicantId) };
}
