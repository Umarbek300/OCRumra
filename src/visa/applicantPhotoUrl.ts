/**
 * The durable, opaque URL written into Sheet column T (personalPhotoUrl) —
 * see writePersonalPhotoUrlIfBlank.ts. `token` is the dedicated, randomly
 * generated personal_photo_token (see generateApplicantPhotoToken.ts) —
 * deliberately NEVER the telegram_message_id, passport number, applicant
 * name, or any other existing identifier, so a leak of this URL cannot be
 * correlated back to any other record this codebase keeps. This URL never
 * expires and never exposes the bucket name or raw GCS object path — every
 * request to it is mediated by applicantPhotoRoute.ts, which looks the
 * object path up from the token server-side.
 */
export function buildApplicantPhotoPublicUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/visa-photos/${token}`;
}
