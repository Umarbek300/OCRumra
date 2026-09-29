import type { OcrConfidenceLevel } from '../db/repositories/passportOcrResult.repo.js';

const CONFIDENCE_SCORE: Record<OcrConfidenceLevel, 0 | 1 | 2> = { low: 0, medium: 1, high: 2 };

export interface CanonicalReassignmentCandidate {
  linkId: string;
  telegramMessageId: string;
  passportNumberConfidence: OcrConfidenceLevel;
  dobConfidence: OcrConfidenceLevel;
  /** ISO timestamp — the source message's own timestamp, used for the tie-break. */
  messageTimestamp: string;
}

/**
 * A candidate's score is the MINIMUM of its two identity fields' confidence
 * — never averaged, never the record's separate overall_confidence field.
 * A candidate is only as strong as its weaker identity field (design spec §F).
 */
export function candidateScore(candidate: Pick<CanonicalReassignmentCandidate, 'passportNumberConfidence' | 'dobConfidence'>): 0 | 1 | 2 {
  return Math.min(
    CONFIDENCE_SCORE[candidate.passportNumberConfidence],
    CONFIDENCE_SCORE[candidate.dobConfidence],
  ) as 0 | 1 | 2;
}

/**
 * Selects which remaining duplicate link should be promoted to canonical
 * once the current canonical leaves the active set (deletion, cancellation,
 * or removal — design spec §F/§G). Highest field-level confidence score
 * wins; a tie resolves to the most recent message. Returns null when no
 * candidates remain at all, signaling the "no remaining source" case that
 * triggers the Sheet-row-deletion path instead of a reassignment.
 *
 * Pure — takes plain candidate data, never queries the database itself, so
 * it's testable without any DB dependency. Callers assemble candidates via
 * passportMessageLinks.repo.ts's findActiveDuplicateCandidates.
 */
export function selectNewCanonical(
  candidates: readonly CanonicalReassignmentCandidate[],
): CanonicalReassignmentCandidate | null {
  if (candidates.length === 0) {
    return null;
  }

  const bestScore = Math.max(...candidates.map(candidateScore));
  const topCandidates = candidates.filter((candidate) => candidateScore(candidate) === bestScore);

  return topCandidates.reduce((latest, candidate) =>
    new Date(candidate.messageTimestamp).getTime() > new Date(latest.messageTimestamp).getTime() ? candidate : latest,
  );
}
