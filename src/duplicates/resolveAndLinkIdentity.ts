import {
  createPassportIdentity,
  findPassportIdentityByKey,
  type PassportIdentityRecord,
} from '../db/repositories/passportIdentity.repo.js';
import {
  createPassportMessageLink,
  findActiveCanonicalLink,
  findPassportMessageLinkById,
  findPassportMessageLinkByTelegramMessageId,
  type PassportLinkRole,
} from '../db/repositories/passportMessageLinks.repo.js';
import { createDuplicateReview, findDuplicateReviewByCandidateMessageId } from '../db/repositories/duplicateReviews.repo.js';
import { recordPassportIdentityEvent } from '../db/repositories/passportIdentityEvents.repo.js';
import type { OcrConfidenceLevel, PassportOcrResultRecord } from '../db/repositories/passportOcrResult.repo.js';
import { normalizePassportNumber } from './normalizePassportNumber.js';
import { resolvePassportIdentity } from './resolvePassportIdentity.js';

export type IdentityResolutionOutcome =
  /** OCR could not read a passport number and/or DOB at all — nothing to key an identity on. Pre-existing (non-duplicate) behavior is unaffected. */
  | { kind: 'NO_IDENTITY_DATA' }
  /** This message already has a passport_message_links row from an earlier run — reprocessing never creates a second one (design spec §I determinism requirement). */
  | { kind: 'ALREADY_RESOLVED'; role: PassportLinkRole }
  /** Flagged for operator review — the Sheet write for this message MUST be suppressed until resolved (design spec §J). */
  | { kind: 'REVIEW' }
  /** Successfully resolved and linked — either a brand-new identity, a new (identity, group) record, or an auto-merged duplicate. */
  | { kind: 'LINKED'; identityId: string; role: PassportLinkRole };

export interface ResolveAndLinkIdentityInput {
  telegramMessageId: string;
  groupId: string;
  agentId: string | null;
  passportNumber: { value: string | null; confidence: OcrConfidenceLevel | null };
  dateOfBirth: { value: string | null; confidence: OcrConfidenceLevel | null };
}

/**
 * Orchestrates duplicate-passport identity resolution for one OCR'd
 * message. Called from src/worker/performPassportOcr.ts after a
 * passport_ocr_results row exists for the message (either just saved, or
 * already existing from an earlier run) — identity can never be resolved
 * before OCR completes.
 *
 * Idempotent: safe to call more than once for the same telegramMessageId
 * (worker retry/restart, or the early-return "result already exists" path
 * in performPassportOcr) — a message that already has a link is never
 * re-resolved or re-linked.
 */
export async function resolveAndLinkIdentity(input: ResolveAndLinkIdentityInput): Promise<IdentityResolutionOutcome> {
  const existingLink = await findPassportMessageLinkByTelegramMessageId(input.telegramMessageId);
  if (existingLink) {
    return { kind: 'ALREADY_RESOLVED', role: existingLink.role };
  }

  const existingReview = await findDuplicateReviewByCandidateMessageId(input.telegramMessageId);
  if (existingReview && existingReview.status === 'pending') {
    return { kind: 'REVIEW' };
  }

  if (!input.passportNumber.value || !input.dateOfBirth.value) {
    return { kind: 'NO_IDENTITY_DATA' };
  }

  const normalizedPassportNumber = normalizePassportNumber(input.passportNumber.value);

  const decision = await resolvePassportIdentity(
    {
      normalizedPassportNumber,
      passportNumberConfidence: input.passportNumber.confidence,
      dateOfBirth: input.dateOfBirth.value,
      dobConfidence: input.dateOfBirth.confidence,
      groupId: input.groupId,
      agentId: input.agentId,
    },
    { findIdentityByKey: findPassportIdentityByKey, findActiveCanonicalLink },
  );

  if (decision.outcome === 'NEW_IDENTITY') {
    const identity = await findOrCreateIdentity(normalizedPassportNumber, input.dateOfBirth.value);
    await recordPassportIdentityEvent({
      passportIdentityId: identity.id,
      eventType: 'identity_created',
      groupId: input.groupId,
      relatedTelegramMessageId: input.telegramMessageId,
      actor: 'system',
    });
    const link = await createPassportMessageLink({
      passportIdentityId: identity.id,
      telegramMessageId: input.telegramMessageId,
      groupId: input.groupId,
      agentId: input.agentId,
      role: 'canonical',
      matchConfidenceTier: 'new_identity',
    });
    // A concurrent run may have already linked this exact message between
    // our own findPassportMessageLinkByTelegramMessageId check and here —
    // benign race, resolved by the same UNIQUE(telegram_message_id)
    // idempotency guarantee used everywhere else in this schema.
    const role = link?.role ?? (await findPassportMessageLinkByTelegramMessageId(input.telegramMessageId))?.role ?? 'canonical';
    await recordPassportIdentityEvent({
      passportIdentityId: identity.id,
      eventType: 'message_linked_canonical',
      groupId: input.groupId,
      relatedTelegramMessageId: input.telegramMessageId,
      actor: 'system',
    });
    return { kind: 'LINKED', identityId: identity.id, role };
  }

  if (decision.outcome === 'NEW_GROUP_RECORD') {
    await createPassportMessageLink({
      passportIdentityId: decision.identityId,
      telegramMessageId: input.telegramMessageId,
      groupId: input.groupId,
      agentId: input.agentId,
      role: 'canonical',
      matchConfidenceTier: 'high',
    });
    await recordPassportIdentityEvent({
      passportIdentityId: decision.identityId,
      eventType: 'message_linked_canonical',
      groupId: input.groupId,
      relatedTelegramMessageId: input.telegramMessageId,
      actor: 'system',
    });
    return { kind: 'LINKED', identityId: decision.identityId, role: 'canonical' };
  }

  if (decision.outcome === 'AUTO_MERGE') {
    await createPassportMessageLink({
      passportIdentityId: decision.identityId,
      telegramMessageId: input.telegramMessageId,
      groupId: input.groupId,
      agentId: input.agentId,
      role: 'duplicate',
      matchConfidenceTier: 'high',
    });
    await recordPassportIdentityEvent({
      passportIdentityId: decision.identityId,
      eventType: 'message_linked_duplicate',
      groupId: input.groupId,
      relatedTelegramMessageId: input.telegramMessageId,
      actor: 'system',
    });
    return { kind: 'LINKED', identityId: decision.identityId, role: 'duplicate' };
  }

  // decision.outcome === 'REVIEW'
  await createDuplicateReview({
    passportIdentityId: decision.identityId,
    candidateTelegramMessageId: input.telegramMessageId,
    matchedAgainstTelegramMessageId: decision.matchedAgainstLinkId
      ? (await findLinkTelegramMessageId(decision.matchedAgainstLinkId))
      : null,
    reviewReason: decision.reviewReason,
  });
  await recordPassportIdentityEvent({
    passportIdentityId: decision.identityId,
    eventType: 'review_flagged',
    groupId: input.groupId,
    relatedTelegramMessageId: input.telegramMessageId,
    actor: 'system',
    detail: `reason=${decision.reviewReason}`,
  });
  return { kind: 'REVIEW' };
}

/** Race-safe find-or-create, same pattern as ensureGroupSheet.ts's handling of groups.google_sheet_id. */
async function findOrCreateIdentity(normalizedPassportNumber: string, dateOfBirth: string): Promise<PassportIdentityRecord> {
  const created = await createPassportIdentity(normalizedPassportNumber, dateOfBirth);
  if (created) {
    return created;
  }
  const winner = await findPassportIdentityByKey(normalizedPassportNumber, dateOfBirth);
  if (!winner) {
    throw new Error(
      `resolveAndLinkIdentity: lost the identity-creation race but no winning row was found for key (${normalizedPassportNumber}, ${dateOfBirth})`,
    );
  }
  return winner;
}

async function findLinkTelegramMessageId(linkId: string): Promise<string | null> {
  const link = await findPassportMessageLinkById(linkId);
  return link?.telegramMessageId ?? null;
}
