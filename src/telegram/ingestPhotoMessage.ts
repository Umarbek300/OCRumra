import { findAgentByTelegramUserId } from '../db/repositories/agents.repo.js';
import { createPassportProcessingRecord } from '../db/repositories/passportProcessing.repo.js';
import {
  backfillCaptionForMediaGroup,
  findCaptionForMediaGroup,
  recordPhotoMessage,
  type TelegramMessageSource,
} from '../db/repositories/telegramMessages.repo.js';
import { enqueuePassportProcessing } from '../queue/passportProcessingQueue.js';
import { ensureGroupRegistered } from './ensureGroupRegistered.js';

export interface PhotoMessageEvent {
  chatId: number;
  messageId: number;
  senderUserId: number;
  senderDisplayName: string | null;
  timestamp: Date;
  photoFileId: string;
  source: TelegramMessageSource;
  /** The message's own Telegram caption, verbatim. Null when sent with no caption. */
  captionText: string | null;
  /** Telegram's album id when this message was sent as part of a media group. Null for a standalone message. */
  mediaGroupId: string | null;
  /**
   * The chat's own current Telegram title, for automatic group
   * registration (see ensureGroupRegistered.ts) -- optional, and only
   * ever used the moment this chat_id has no registered Group yet. Never
   * required by any existing caller; omitting it (or passing null)
   * preserves this function's exact pre-existing behavior of leaving the
   * message unlinked when the chat isn't registered.
   */
  chatTitle?: string | null;
}

export interface IngestResult {
  outcome: 'inserted' | 'duplicate';
  groupLinked: boolean;
  agentLinked: boolean;
  processingEnqueued: boolean;
}

/**
 * Resolves the Telegram chat/sender against registered Groups/Agents and
 * persists the event. Never guesses an Agent — an unregistered sender is
 * always recorded with a null agent link, visible via the admin/debug
 * surface. A Group, by contrast, is now auto-registered via
 * ensureGroupRegistered.ts whenever the chat's own current title parses
 * confidently as a departure date (never a guess otherwise — see that
 * function's own doc comment) — including retroactively backfilling any
 * of this chat's earlier messages that were recorded before its group
 * existed.
 *
 * Telegram attaches a caption to only ONE message of a media group (album)
 * — every sibling photo/document sent in the same album arrives with
 * caption = undefined, even when the operator wrote one caption for the
 * whole album (e.g. front+back passport photos sent together with
 * "Package: $1400" as the caption). Two correlation steps handle this
 * without ever guessing a caption that wasn't actually typed:
 *  1) Before inserting, if this message has no caption of its own but does
 *     have a media_group_id, borrow an already-recorded sibling's caption
 *     for the same album (see findCaptionForMediaGroup).
 *  2) After inserting, if THIS message did carry its own caption and has a
 *     media_group_id, backfill any earlier sibling in the same album that
 *     is still missing one (see backfillCaptionForMediaGroup) — covering
 *     the case where the caption-carrying photo isn't the first to arrive.
 * A standalone message (no media_group_id) is completely unaffected by
 * either step, so this never changes behavior for the common non-album
 * case.
 *
 * A newly inserted, fully linked (group + agent) message gets a
 * passport_processing record and is pushed onto the Redis queue. A
 * duplicate Telegram update or an unlinked message never gets a
 * processing record or a queue entry.
 */
export async function ingestPhotoMessage(event: PhotoMessageEvent): Promise<IngestResult> {
  const [{ group }, agent] = await Promise.all([
    ensureGroupRegistered(event.chatId, event.chatTitle ?? null),
    findAgentByTelegramUserId(event.senderUserId),
  ]);
  const groupLinked = group !== null;
  const agentLinked = agent !== null;

  let captionText = event.captionText;
  if (captionText === null && event.mediaGroupId !== null) {
    captionText = await findCaptionForMediaGroup(event.chatId, event.mediaGroupId);
  }

  const result = await recordPhotoMessage({
    telegramChatId: event.chatId,
    telegramMessageId: event.messageId,
    telegramSenderUserId: event.senderUserId,
    telegramSenderDisplayName: event.senderDisplayName,
    messageTimestamp: event.timestamp,
    telegramPhotoFileId: event.photoFileId,
    source: event.source,
    groupId: group?.id ?? null,
    agentId: agent?.id ?? null,
    captionText,
    mediaGroupId: event.mediaGroupId,
  });

  if (result.outcome === 'inserted' && event.captionText !== null && event.mediaGroupId !== null) {
    await backfillCaptionForMediaGroup(event.chatId, event.mediaGroupId, event.captionText);
  }

  let processingEnqueued = false;

  if (result.outcome === 'inserted' && groupLinked && agentLinked) {
    const processingRecord = await createPassportProcessingRecord(result.message.id);
    if (processingRecord) {
      try {
        await enqueuePassportProcessing(processingRecord.telegramMessageId);
        processingEnqueued = true;
      } catch (error) {
        // The processing record already exists (status='queued') in Postgres,
        // so the job isn't lost — it's just not on the queue yet. Don't fail
        // ingestion over a transient Redis problem.
        console.error(
          `Failed to enqueue passport processing for telegram_message=${processingRecord.telegramMessageId}; ` +
            'record remains status=queued in Postgres for later recovery',
          error,
        );
      }
    }
  }

  return { outcome: result.outcome, groupLinked, agentLinked, processingEnqueued };
}
