import {
  findActiveCanonicalLink,
  findPassportMessageLinkByTelegramMessageId,
} from '../db/repositories/passportMessageLinks.repo.js';
import { findTelegramMessageByChatAndMessageId } from '../db/repositories/telegramMessages.repo.js';
import { submitOperatorCommand } from '../duplicates/submitOperatorCommand.js';

export interface RemovePassportCommandInput {
  telegramChatId: number;
  telegramMessageId: number;
  operatorId: string;
}

export type RemovePassportCommandOutcome =
  | { kind: 'MESSAGE_NOT_FOUND' }
  | { kind: 'NOT_A_PASSPORT_MESSAGE' }
  /** Nothing left to remove -- either never had, or already had, an active canonical retired for this (identity, group). Idempotent: replying /remove twice is always safe. */
  | { kind: 'ALREADY_REMOVED' }
  | { kind: 'SUBMITTED'; alreadyPending: boolean };

export interface RemovePassportCommandDependencies {
  findMessage: typeof findTelegramMessageByChatAndMessageId;
  findLink: typeof findPassportMessageLinkByTelegramMessageId;
  findActiveCanonical: typeof findActiveCanonicalLink;
  submit: typeof submitOperatorCommand;
}

const defaultDependencies: RemovePassportCommandDependencies = {
  findMessage: findTelegramMessageByChatAndMessageId,
  findLink: findPassportMessageLinkByTelegramMessageId,
  findActiveCanonical: findActiveCanonicalLink,
  submit: submitOperatorCommand,
};

/**
 * The Telegram-facing entry point behind the /remove bot command: an
 * operator replies "/remove" to a passport photo instead of deleting the
 * Telegram message itself. Deleting a message is never observable by a bot
 * at all -- Telegram's Bot API has no message-deletion event for ordinary
 * group/supergroup chats (see migrations/0020_create_passport_operator_
 * commands.sql's own doc comment) -- so this explicit, reply-driven command
 * is the practical equivalent operators use to get the same real-world
 * outcome: the passport's row disappears from this group's Sheet.
 *
 * Resolves the replied-to Telegram message down to (passportIdentityId,
 * groupId) and then delegates every actual domain decision to
 * submitOperatorCommand.ts -- the exact same production-safe entry point
 * the `admin:operator-command` CLI already uses. This function itself never
 * mutates passport_identity, passport_message_links, or the Sheet.
 *
 * Deliberately resolves via the replied-to message's OWN link row to find
 * (identity, group), then checks whether THAT PAIR currently has an active
 * canonical -- not whether the replied-to message's own link is still
 * active. A reply to an old duplicate-role message (or one already
 * cancelled/moved) still correctly targets and retires whatever the group's
 * CURRENT canonical for that passport is, matching retireInGroup's own
 * "operate on the (identity, group) pair, not the specific message cited"
 * semantics (see processOperatorCommand.ts).
 */
export async function removePassportCommand(
  input: RemovePassportCommandInput,
  deps: RemovePassportCommandDependencies = defaultDependencies,
): Promise<RemovePassportCommandOutcome> {
  const message = await deps.findMessage(input.telegramChatId, input.telegramMessageId);
  if (!message) {
    return { kind: 'MESSAGE_NOT_FOUND' };
  }

  const link = await deps.findLink(message.id);
  if (!link) {
    return { kind: 'NOT_A_PASSPORT_MESSAGE' };
  }

  const activeCanonical = await deps.findActiveCanonical(link.passportIdentityId, link.groupId);
  if (!activeCanonical) {
    return { kind: 'ALREADY_REMOVED' };
  }

  const result = await deps.submit({
    commandType: 'remove_from_group',
    passportIdentityId: link.passportIdentityId,
    groupId: link.groupId,
    telegramMessageId: message.id,
    operatorId: input.operatorId,
  });

  return { kind: 'SUBMITTED', alreadyPending: result.outcome === 'already_pending' };
}
