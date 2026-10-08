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

/**
 * The durable, opaque URL written into Sheet column V (personalPortraitUrl)
 * — see writePersonalPhotoUrlIfBlank.ts. `token` is the dedicated, randomly
 * generated personal_portrait_token, deliberately NEVER the
 * telegram_message_id, personal_photo_token, or any other existing
 * identifier. A fully independent path prefix (/visa-portraits/, not
 * /visa-photos/) from buildApplicantPhotoPublicUrl above, since this URL is
 * mediated by applicantPortraitRoute.ts — a separate route backed by a
 * separate, portrait-only token lookup — never applicantPhotoRoute.ts.
 */
export function buildApplicantPortraitPublicUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/visa-portraits/${token}`;
}
