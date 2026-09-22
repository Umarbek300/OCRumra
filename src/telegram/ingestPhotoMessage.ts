import { findAgentByTelegramUserId } from '../db/repositories/agents.repo.js';
import { findGroupByTelegramChatId } from '../db/repositories/groups.repo.js';
import { createPassportProcessingRecord } from '../db/repositories/passportProcessing.repo.js';
import { recordPhotoMessage, type TelegramMessageSource } from '../db/repositories/telegramMessages.repo.js';
import { enqueuePassportProcessing } from '../queue/passportProcessingQueue.js';

export interface PhotoMessageEvent {
  chatId: number;
  messageId: number;
  senderUserId: number;
  senderDisplayName: string | null;
  timestamp: Date;
  photoFileId: string;
  source: TelegramMessageSource;
}

export interface IngestResult {
  outcome: 'inserted' | 'duplicate';
  groupLinked: boolean;
  agentLinked: boolean;
  processingEnqueued: boolean;
}

/**
 * Resolves the Telegram chat/sender against registered Groups/Agents and
 * persists the event. Never creates a Group or guesses an Agent — an
 * unregistered chat or sender is simply recorded with a null link, visible
 * via the admin/debug surface.
 *
 * A newly inserted, fully linked (group + agent) message gets a
 * passport_processing record and is pushed onto the Redis queue. A
 * duplicate Telegram update or an unlinked message never gets a
 * processing record or a queue entry.
 */
export async function ingestPhotoMessage(event: PhotoMessageEvent): Promise<IngestResult> {
  const [group, agent] = await Promise.all([
    findGroupByTelegramChatId(event.chatId),
    findAgentByTelegramUserId(event.senderUserId),
  ]);
  const groupLinked = group !== null;
  const agentLinked = agent !== null;

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
  });

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
