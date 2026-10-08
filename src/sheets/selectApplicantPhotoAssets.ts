import type { ApplicantPhotoAssetCandidate } from '../db/repositories/passportMessageLinks.repo.js';

export interface CanonicalApplicantPhotoAssets {
  telegramMessageId: string;
  personalPhotoToken: string | null;
  personalPortraitToken: string | null;
}

export interface SelectedApplicantPhotoAssets {
  photoToken: string | null;
  portraitToken: string | null;
}

function pickLatestToken(
  candidates: readonly ApplicantPhotoAssetCandidate[],
  excludeTelegramMessageId: string,
  pick: (candidate: ApplicantPhotoAssetCandidate) => string | null,
): string | null {
  const withToken = candidates.filter((candidate) => candidate.telegramMessageId !== excludeTelegramMessageId && pick(candidate) !== null);
  if (withToken.length === 0) {
    return null;
  }
  const latest = withToken.reduce((latest, candidate) =>
    new Date(candidate.messageTimestamp).getTime() > new Date(latest.messageTimestamp).getTime() ? candidate : latest,
  );
  return pick(latest);
}

/**
 * Resolves which personal_photo_token/personal_portrait_token a (identity,
 * group)'s canonical Sheet row should actually use for its T/V-column
 * URLs. The canonical message's own token always wins when it has one —
 * this is a pure FALLBACK, never a "best available" re-ranking, so the
 * overwhelmingly common case (canonical already has its own photo/portrait,
 * or there are no duplicates at all) is completely unaffected: the result
 * is identical to just reading ocrResult.personalPhotoToken/
 * personalPortraitToken directly, as syncPassportRowToSheet.ts did before
 * this selection step existed.
 *
 * Only when the canonical's own token is null does this fall back to the
 * MOST RECENTLY SENT active duplicate (by its message's own timestamp) that
 * does have one — candidates are assembled by passportMessageLinks.repo.ts's
 * findApplicantPhotoAssetCandidates, which already excludes
 * cancelled/removed/moved links. The canonical's own candidate entry (if
 * present in `candidates`) is never itself selected as a "fallback" — it
 * was already checked directly via `canonical.personalPhotoToken`/
 * `personalPortraitToken`.
 *
 * photo and portrait are resolved completely independently: one asset can
 * come from the canonical message while the other falls back to a
 * different duplicate, since a single message can have one without the
 * other (e.g. a photo was uploaded but no face region was ever found for
 * cropping).
 *
 * This NEVER changes which message is canonical, never touches
 * passport_identities/passport_message_links, and has no opinion about the
 * row's name/passport/DOB fields (those keep coming from the canonical
 * ocrResult alone, via buildSheetRow — untouched by this function).
 *
 * Pure — takes plain candidate data, never queries the database itself, so
 * it's testable without any DB dependency.
 */
export function selectApplicantPhotoAssets(
  canonical: CanonicalApplicantPhotoAssets,
  candidates: readonly ApplicantPhotoAssetCandidate[],
): SelectedApplicantPhotoAssets {
  return {
    photoToken: canonical.personalPhotoToken ?? pickLatestToken(candidates, canonical.telegramMessageId, (c) => c.personalPhotoToken),
    portraitToken:
      canonical.personalPortraitToken ?? pickLatestToken(candidates, canonical.telegramMessageId, (c) => c.personalPortraitToken),
  };
}
