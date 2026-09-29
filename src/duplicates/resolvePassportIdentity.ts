import type { OcrConfidenceLevel } from '../db/repositories/passportOcrResult.repo.js';

export interface ResolvePassportIdentityInput {
  /** Already normalized via normalizePassportNumber.ts — this function never normalizes its input itself. */
  normalizedPassportNumber: string;
  passportNumberConfidence: OcrConfidenceLevel | null;
  /** ISO date string, matching passport_identity.date_of_birth. */
  dateOfBirth: string;
  dobConfidence: OcrConfidenceLevel | null;
  groupId: string;
  agentId: string | null;
}

export interface ExistingIdentityLookup {
  id: string;
}

export interface ExistingCanonicalLink {
  id: string;
  agentId: string | null;
}

export interface ResolvePassportIdentityDeps {
  findIdentityByKey(normalizedPassportNumber: string, dateOfBirth: string): Promise<ExistingIdentityLookup | null>;
  findActiveCanonicalLink(identityId: string, groupId: string): Promise<ExistingCanonicalLink | null>;
}

export type PassportIdentityDecision =
  | { outcome: 'NEW_IDENTITY' }
  | { outcome: 'REVIEW'; reviewReason: 'low_confidence_field'; identityId: string; matchedAgainstLinkId: null }
  | { outcome: 'REVIEW'; reviewReason: 'agent_mismatch'; identityId: string; matchedAgainstLinkId: string }
  | { outcome: 'NEW_GROUP_RECORD'; identityId: string }
  | { outcome: 'AUTO_MERGE'; identityId: string; canonicalLinkId: string };

/**
 * Pure decision function implementing the finalized duplicate-passport
 * matching precedence (design spec §C). Deliberately takes its DB lookups
 * as injected deps rather than importing the repos directly, so this can
 * be unit-tested with plain fakes, never a real database.
 *
 * PRECONDITION: normalizedPassportNumber/dateOfBirth are the single,
 * already-resolved values for this OCR result. Any MRZ-vs-visual-zone
 * internal disagreement within one message's own OCR result MUST be
 * resolved (or itself routed to review) upstream of this function — it
 * never reconciles conflicting raw fields from a single source itself.
 *
 * Precedence, in order:
 *   1. No existing identity at this key -> NEW_IDENTITY.
 *   2. Existing identity, but passport number AND DOB are not BOTH
 *      field-level HIGH confidence -> REVIEW (low_confidence_field).
 *      overall_confidence is never consulted here.
 *   3. Both fields HIGH, but no active canonical link exists yet for this
 *      (identity, group) -> NEW_GROUP_RECORD (same global identity, first
 *      appearance in this group — never disturbs another group's record).
 *   4. Both fields HIGH, canonical exists for this group, but its agentId
 *      differs from the input's -> REVIEW (agent_mismatch). This check is
 *      absolute: it overrides confidence and always wins once reached.
 *   5. Otherwise -> AUTO_MERGE.
 */
export async function resolvePassportIdentity(
  input: ResolvePassportIdentityInput,
  deps: ResolvePassportIdentityDeps,
): Promise<PassportIdentityDecision> {
  const identity = await deps.findIdentityByKey(input.normalizedPassportNumber, input.dateOfBirth);
  if (!identity) {
    return { outcome: 'NEW_IDENTITY' };
  }

  const isFieldLevelHigh = input.passportNumberConfidence === 'high' && input.dobConfidence === 'high';
  if (!isFieldLevelHigh) {
    return { outcome: 'REVIEW', reviewReason: 'low_confidence_field', identityId: identity.id, matchedAgainstLinkId: null };
  }

  const canonicalLink = await deps.findActiveCanonicalLink(identity.id, input.groupId);
  if (!canonicalLink) {
    return { outcome: 'NEW_GROUP_RECORD', identityId: identity.id };
  }

  if (canonicalLink.agentId !== input.agentId) {
    return {
      outcome: 'REVIEW',
      reviewReason: 'agent_mismatch',
      identityId: identity.id,
      matchedAgainstLinkId: canonicalLink.id,
    };
  }

  return { outcome: 'AUTO_MERGE', identityId: identity.id, canonicalLinkId: canonicalLink.id };
}
