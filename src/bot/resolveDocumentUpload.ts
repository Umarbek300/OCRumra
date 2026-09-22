// Telegram's regular Bot API (api.telegram.org, no local Bot API server in
// this deployment) hard-caps getFile downloads at 20MB regardless of what
// this app does - files above that cannot be fetched this way at all. This
// mirrors that documented platform limit rather than inventing a number, so
// an oversized document.file_size is rejected early instead of round-
// tripping through DB/queue only to fail downstream.
export const MAX_DOCUMENT_SIZE_BYTES = 20 * 1024 * 1024;

export const ACCEPTED_DOCUMENT_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export interface DocumentUploadCandidate {
  /** Client-supplied, optional, and not trustworthy - an advisory pre-filter only. */
  mimeType?: string;
  fileSize?: number;
}

export type DocumentUploadDecision =
  | { accepted: true }
  | { accepted: false; reason: 'unsupported-mime-type' | 'too-large' };

/**
 * Pure decision logic for whether a Telegram `document` upload should be
 * ingested as a passport photo candidate. Both checks are advisory/early
 * exits, not security boundaries: an unset mimeType or fileSize is never
 * rejected on that basis alone, since Telegram doesn't always report them
 * and the real safety net is downstream (downloadTelegramPhoto's existing
 * error handling, and sharp failing gracefully on non-image content).
 */
export function evaluateDocumentUpload(candidate: DocumentUploadCandidate): DocumentUploadDecision {
  if (candidate.mimeType && !(ACCEPTED_DOCUMENT_MIME_TYPES as readonly string[]).includes(candidate.mimeType)) {
    return { accepted: false, reason: 'unsupported-mime-type' };
  }
  if (candidate.fileSize !== undefined && candidate.fileSize > MAX_DOCUMENT_SIZE_BYTES) {
    return { accepted: false, reason: 'too-large' };
  }
  return { accepted: true };
}
