import { findAgentByTelegramUserId } from '../db/repositories/agents.repo.js';
import { findGroupByTelegramChatId } from '../db/repositories/groups.repo.js';
import { recordPhotoMessage } from '../db/repositories/telegramMessages.repo.js';

export interface PhotoMessageEvent {
  chatId: number;
  messageId: number;
  senderUserId: number;
  senderDisplayName: string | null;
  timestamp: Date;
  photoFileId: string;
}

export interface IngestResult {
  outcome: 'inserted' | 'duplicate';
  groupLinked: boolean;
  agentLinked: boolean;
}

/**
 * Resolves the Telegram chat/sender against registered Groups/Agents and
 * persists the event. Never creates a Group or guesses an Agent — an
 * unregistered chat or sender is simply recorded with a null link, visible
 * via the admin/debug surface.
 */
export async function ingestPhotoMessage(event: PhotoMessageEvent): Promise<IngestResult> {
  const [group, agent] = await Promise.all([
    findGroupByTelegramChatId(event.chatId),
    findAgentByTelegramUserId(event.senderUserId),
  ]);

  const result = await recordPhotoMessage({
    telegramChatId: event.chatId,
    telegramMessageId: event.messageId,
    telegramSenderUserId: event.senderUserId,
    telegramSenderDisplayName: event.senderDisplayName,
    messageTimestamp: event.timestamp,
    telegramPhotoFileId: event.photoFileId,
    groupId: group?.id ?? null,
    agentId: agent?.id ?? null,
  });

  return {
    outcome: result.outcome,
    groupLinked: group !== null,
    agentLinked: agent !== null,
  };
}
