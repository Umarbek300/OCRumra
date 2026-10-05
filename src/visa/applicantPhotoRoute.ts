import { findPassportOcrResultByPersonalPhotoToken } from '../db/repositories/passportOcrResult.repo.js';
import { getApplicantPhotoBucket, resolveApplicantPhotoStorageConfig, type ApplicantPhotoStorageConfig } from './uploadApplicantPhoto.js';

/** Only what this handler needs from an Express Request — kept minimal and dependency-light so it's testable without pulling in real Express. */
export interface PhotoRouteRequest {
  params: { token?: string };
}

/** Only what this handler needs from an Express Response — an Express Response (http.ServerResponse) structurally satisfies this, being a writable stream with these extra methods. */
export interface PhotoRouteResponse extends NodeJS.WritableStream {
  status(code: number): PhotoRouteResponse;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
  headersSent: boolean;
}

/** What the route needs from a GCS bucket handle — a real Bucket (from getApplicantPhotoBucket) satisfies this structurally. */
export interface PhotoBucketLike {
  file(objectPath: string): { createReadStream(): NodeJS.ReadableStream };
}

// Matches generateApplicantPhotoToken.ts's own output shape: base64url of
// 32 random bytes is exactly 43 characters, but this is intentionally a
// little permissive on length (rather than hardcoding =43) so a future
// entropy change doesn't require touching this route too. Crucially, a
// telegram_message_id (a UUID, 36 chars WITH hyphens in fixed positions)
// can incidentally match this shape-only check — the real rejection of
// telegram_message_id (and every other existing identifier) as a token
// comes from the DB lookup below being scoped to personal_photo_token
// specifically (see findPassportOcrResultByPersonalPhotoToken's own doc
// comment), which such a value will simply never match.
const TOKEN_SHAPE_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
};

function inferContentType(objectPath: string): string {
  const extension = objectPath.split('.').pop()?.toLowerCase() ?? '';
  return CONTENT_TYPE_BY_EXTENSION[extension] ?? 'application/octet-stream';
}

export interface ApplicantPhotoRouteDependencies {
  findOcrResult: typeof findPassportOcrResultByPersonalPhotoToken;
  config: ApplicantPhotoStorageConfig | null;
  getBucket: (config: ApplicantPhotoStorageConfig) => PhotoBucketLike;
}

const defaultDependencies: ApplicantPhotoRouteDependencies = {
  findOcrResult: findPassportOcrResultByPersonalPhotoToken,
  config: resolveApplicantPhotoStorageConfig(),
  getBucket: getApplicantPhotoBucket,
};

/**
 * Serves one applicant's personal photo privately. The URL's token is the
 * DEDICATED, cryptographically random personal_photo_token (see
 * generateApplicantPhotoToken.ts / applicantPhotoUrl.ts) — looked up via
 * findPassportOcrResultByPersonalPhotoToken, which matches ONLY that
 * column. This route never accepts, and has no code path that falls back
 * to, telegram_message_id, passport number, applicant name, DOB, or any
 * other existing identifier as the token — passing one of those here
 * simply won't match any row's personal_photo_token and returns 404, the
 * same as any other invalid token.
 *
 * The bucket itself stays fully private — no public ACL, no signed URL is
 * ever generated or exposed. Every fetch is mediated by this route, whose
 * only "authentication" is knowledge of the opaque token (the same
 * capability-URL model as, e.g., a private calendar's ICS link) — this
 * matches the explicit design decision to prefer a durable app-mediated
 * URL over a GCS signed URL, which would expire before an eventual
 * VisitSaudi automation step might fetch it.
 *
 * The response never includes the bucket name, the GCS object path,
 * telegram_message_id, passport number, or any other PII/credential
 * material — on every error path only a generic message is returned to
 * the client, with the real error (if any) logged server-side only.
 */
export async function handleApplicantPhotoRequest(
  req: PhotoRouteRequest,
  res: PhotoRouteResponse,
  deps: ApplicantPhotoRouteDependencies = defaultDependencies,
): Promise<void> {
  const token = req.params.token;
  if (!token || !TOKEN_SHAPE_PATTERN.test(token)) {
    res.status(400).json({ error: 'invalid token' });
    return;
  }

  if (!deps.config) {
    res.status(503).json({ error: 'photo storage not configured' });
    return;
  }

  let ocrResult: Awaited<ReturnType<typeof deps.findOcrResult>>;
  try {
    ocrResult = await deps.findOcrResult(token);
  } catch (error) {
    console.error('[visa-photos] failed to look up OCR result for a photo request', error);
    res.status(500).json({ error: 'internal error' });
    return;
  }

  // findOcrResult matches EITHER personal_photo_token (original passport)
  // OR personal_portrait_token (cropped portrait) — see its own doc comment
  // in passportOcrResult.repo.ts. Which object to serve depends on which of
  // the two token columns actually equals the REQUESTED token, never on
  // which one happens to be non-null (a row can legitimately have both).
  const objectPath =
    ocrResult?.personalPhotoToken === token
      ? ocrResult.personalPhotoObjectPath
      : ocrResult?.personalPortraitToken === token
        ? ocrResult.personalPortraitObjectPath
        : null;
  if (!objectPath) {
    res.status(404).json({ error: 'photo not found' });
    return;
  }

  const file = deps.getBucket(deps.config).file(objectPath);

  res.setHeader('Content-Type', inferContentType(objectPath));
  res.setHeader('Cache-Control', 'private, max-age=3600');

  const stream = file.createReadStream();
  stream.on('error', (error: unknown) => {
    console.error('[visa-photos] failed to stream the photo object from storage', error);
    if (!res.headersSent) {
      res.status(404).json({ error: 'photo not found' });
    } else {
      res.end();
    }
  });
  stream.pipe(res);
}
