import { findTelegramMessageByChatAndMessageId } from '../db/repositories/telegramMessages.repo.js';
import { findPassportMessageLinkByTelegramMessageId } from '../db/repositories/passportMessageLinks.repo.js';
import { findActiveAssignment } from '../db/repositories/visaBatches.repo.js';

export type ResolveReplyToVisaApplicantOutcome =
  /** The command was not sent as a reply to any message. */
  | { kind: 'NO_REPLY' }
  /** The replied-to message is not one this system has recorded (wrong chat, or never ingested). */
  | { kind: 'MESSAGE_NOT_FOUND' }
  /** The message has no CURRENT (active) passport link -- cancelled/removed/moved away, or never linked at all. */
  | { kind: 'NO_ACTIVE_LINK' }
  /** The linked identity has no VisitSaudi batch assignment in that message's own group. */
  | { kind: 'NO_BATCH_ASSIGNMENT' }
  | { kind: 'RESOLVED'; visaBatchApplicantId: string };

export interface ResolveReplyToVisaApplicantDependencies {
  findTelegramMessage: typeof findTelegramMessageByChatAndMessageId;
  findLink: typeof findPassportMessageLinkByTelegramMessageId;
  findAssignment: typeof findActiveAssignment;
}

const defaultDependencies: ResolveReplyToVisaApplicantDependencies = {
  findTelegramMessage: findTelegramMessageByChatAndMessageId,
  findLink: findPassportMessageLinkByTelegramMessageId,
  findAssignment: findActiveAssignment,
};

/**
 * Turns "operator replied to THIS Telegram message" into a specific
 * visa_batch_applicants id -- the ONLY applicant-identification path this
 * feature uses. Deliberately built entirely from existing, independently
 * tested lookups (no new heuristic, no guessing from text or message
 * order):
 *
 *   Telegram (chat, message) pair
 *     -> findTelegramMessageByChatAndMessageId (scoped to THIS chat --
 *        a reply can never resolve to a message from another chat)
 *     -> findPassportMessageLinkByTelegramMessageId, requiring
 *        linkStatus === 'active' (a cancelled/removed/moved/superseded
 *        link is never treated as current)
 *     -> findActiveAssignment(link.groupId, link.passportIdentityId, 'visitsaudi')
 *
 * Using the LINK's own groupId (not a separately-resolved "current chat
 * group") is deliberate and safe: if the identity was ever MOVE_TO_GROUP'd
 * away from this chat's group, its link here would no longer be the
 * active one (the move retires the old link, see
 * applyIdentityStateChange.ts), so NO_ACTIVE_LINK is returned instead --
 * this can never resolve to an applicant in a DIFFERENT group than the
 * message's own, current, active link says it belongs to. The calling
 * command (visaStopApplicantCommand.ts / visaCheckAmbiguousCommand.ts)
 * separately re-verifies group ownership against the chat itself before
 * acting, as a second, independent layer.
 */
export async function resolveReplyToVisaApplicant(
  telegramChatId: number,
  repliedToMessageId: number | null,
  deps: ResolveReplyToVisaApplicantDependencies = defaultDependencies,
): Promise<ResolveReplyToVisaApplicantOutcome> {
  if (repliedToMessageId === null) {
    return { kind: 'NO_REPLY' };
  }

  const telegramMessage = await deps.findTelegramMessage(telegramChatId, repliedToMessageId);
  if (!telegramMessage) {
    return { kind: 'MESSAGE_NOT_FOUND' };
  }

  const link = await deps.findLink(telegramMessage.id);
  if (!link || link.linkStatus !== 'active') {
    return { kind: 'NO_ACTIVE_LINK' };
  }

  const assignment = await deps.findAssignment(link.groupId, link.passportIdentityId, 'visitsaudi');
  if (!assignment) {
    return { kind: 'NO_BATCH_ASSIGNMENT' };
  }

  return { kind: 'RESOLVED', visaBatchApplicantId: assignment.id };
}
