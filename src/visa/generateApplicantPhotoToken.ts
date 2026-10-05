import { randomBytes } from 'node:crypto';

/** 32 bytes = 256 bits of entropy from Node's CSPRNG — well above the 128-bit minimum. base64url is URL-path-safe (no '/', '+', or '=' padding), so the result can be used directly as a URL segment with no further encoding. */
const TOKEN_BYTE_LENGTH = 32;

/**
 * Generates a fresh, cryptographically random opaque token for one
 * applicant photo's public URL (see applicantPhotoUrl.ts /
 * applicantPhotoRoute.ts) — called ONLY at the moment a photo upload
 * actually succeeds (see performPassportOcr.ts), never derived from any
 * existing identifier (telegram_message_id, passport number, name, DOB).
 * Each call is independent and unguessable; collision probability across
 * any realistic number of applicants is astronomically small (256 bits of
 * entropy), and the DB's own partial unique index on personal_photo_token
 * is the hard backstop regardless.
 */
export function generateApplicantPhotoToken(): string {
  return randomBytes(TOKEN_BYTE_LENGTH).toString('base64url');
}
