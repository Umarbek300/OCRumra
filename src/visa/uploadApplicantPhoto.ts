import { Storage, type Bucket } from '@google-cloud/storage';
import { env } from '../config/env.js';

export interface ApplicantPhotoStorageConfig {
  bucketName: string;
  keyFilePath: string;
}

export interface ApplicantPhotoStorageEnvSource {
  GCS_VISA_PHOTOS_BUCKET?: string;
  GCS_VISA_PHOTOS_SERVICE_ACCOUNT_KEY_FILE?: string;
}

/**
 * Returns null (never throws) when photo storage isn't configured in this
 * environment — callers treat that as "skip the upload", never an error,
 * so OCR processing is never blocked on this optional feature being wired
 * up yet (same opt-in convention as SHEETS_SYNC_ENABLED elsewhere).
 *
 * The default is cast rather than passed directly: ApplicantPhotoStorageEnvSource
 * is a "weak type" (every property optional) deliberately decoupled from
 * env.schema.ts's own Env type, so this module type-checks correctly even
 * in an environment where env.schema.ts hasn't yet been extended with these
 * two vars (TypeScript's weak-type check would otherwise reject `env` as
 * the default here, since the two types would share zero property names at
 * all until that schema update lands) — see env.schema.ts's own addition of
 * GCS_VISA_PHOTOS_BUCKET/GCS_VISA_PHOTOS_SERVICE_ACCOUNT_KEY_FILE for when
 * this cast becomes redundant (but still harmless) going forward.
 */
export function resolveApplicantPhotoStorageConfig(
  source: ApplicantPhotoStorageEnvSource = env as ApplicantPhotoStorageEnvSource,
): ApplicantPhotoStorageConfig | null {
  if (!source.GCS_VISA_PHOTOS_BUCKET || !source.GCS_VISA_PHOTOS_SERVICE_ACCOUNT_KEY_FILE) {
    return null;
  }
  return { bucketName: source.GCS_VISA_PHOTOS_BUCKET, keyFilePath: source.GCS_VISA_PHOTOS_SERVICE_ACCOUNT_KEY_FILE };
}

const EXTENSION_BY_MIME_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

function extensionForMimeType(mimeType: string): string {
  return EXTENSION_BY_MIME_TYPE[mimeType] ?? 'jpg';
}

/**
 * Keyed by telegram_message_id — the same stable, PII-free identity key
 * this whole schema already addresses a photo's own OCR row by (see
 * passport_ocr_results' own UNIQUE telegram_message_id) — deliberately
 * never the passport number or applicant name, so the object path itself
 * carries no PII and is safe to log/reference.
 */
export function buildApplicantPhotoObjectPath(telegramMessageId: string, mimeType: string): string {
  return `visa-photos/${telegramMessageId}.${extensionForMimeType(mimeType)}`;
}

let cachedStorage: Storage | null = null;
let cachedKeyFilePath: string | null = null;

/**
 * Lazily builds (and caches) the real Storage client from a key-file path
 * — same lazy-singleton shape as sheetsAuth.ts's getSheetsClients. Never
 * logs the client, the key file's path's contents, or anything derived
 * from the key material.
 */
function getStorageClient(keyFilePath: string): Storage {
  if (cachedStorage && cachedKeyFilePath === keyFilePath) {
    return cachedStorage;
  }
  cachedStorage = new Storage({ keyFilename: keyFilePath });
  cachedKeyFilePath = keyFilePath;
  return cachedStorage;
}

/** Test-only: clears the cached client singleton, mirroring sheetsAuth.ts's own test helper. */
export function __resetApplicantPhotoStorageClientForTests(): void {
  cachedStorage = null;
  cachedKeyFilePath = null;
}

/** Shared bucket handle, reused by both the uploader below and the private-photo streaming route (applicantPhotoRoute.ts). */
export function getApplicantPhotoBucket(config: ApplicantPhotoStorageConfig): Bucket {
  return getStorageClient(config.keyFilePath).bucket(config.bucketName);
}

export interface UploadApplicantPhotoInput {
  telegramMessageId: string;
  buffer: Buffer;
  mimeType: string;
}

export interface UploadApplicantPhotoDependencies {
  config: ApplicantPhotoStorageConfig | null;
  getBucket: typeof getApplicantPhotoBucket;
}

const defaultDependencies: UploadApplicantPhotoDependencies = {
  config: resolveApplicantPhotoStorageConfig(),
  getBucket: getApplicantPhotoBucket,
};

// TEMPORARY diagnostic (remove once root cause is confirmed): investigating
// why personal_photo_object_path stays null in production despite GCS/IAM/
// env all independently verified working outside this process. Fires ONCE
// at module load (worker startup) -- never touches GCS or the DB, never
// logs secret values, only presence booleans and the non-secret bucket name.
console.log(
  '[photo-storage-diagnostic]',
  JSON.stringify({
    envBucketType: typeof process.env.GCS_VISA_PHOTOS_BUCKET,
    envKeyFileType: typeof process.env.GCS_VISA_PHOTOS_SERVICE_ACCOUNT_KEY_FILE,
    resolvedConfig: defaultDependencies.config
      ? { bucketName: defaultDependencies.config.bucketName, hasKeyFilePath: Boolean(defaultDependencies.config.keyFilePath) }
      : null,
  }),
);

/**
 * Uploads the ALREADY-DOWNLOADED Telegram photo buffer (see
 * downloadTelegramPhoto.ts, called once by performPassportOcr.ts — this
 * function never downloads anything itself) to the private applicant-
 * photos GCS bucket. Returns null (not an error) when photo storage isn't
 * configured at all in this environment (see resolveApplicantPhotoStorage
 * Config) — callers must never let that block OCR from succeeding.
 *
 * The bucket stays fully private (no ACL is ever set here, uniform
 * bucket-level access + public access prevention are enforced at the
 * bucket level, outside this codebase) — this function only ever writes
 * object bytes, never touches access control.
 */
export async function uploadApplicantPhoto(
  input: UploadApplicantPhotoInput,
  deps: UploadApplicantPhotoDependencies = defaultDependencies,
): Promise<string | null> {
  if (!deps.config) {
    return null;
  }
  const objectPath = buildApplicantPhotoObjectPath(input.telegramMessageId, input.mimeType);
  const file = deps.getBucket(deps.config).file(objectPath);
  await file.save(input.buffer, { contentType: input.mimeType, resumable: false });
  return objectPath;
}

/**
 * Keyed by telegram_message_id like buildApplicantPhotoObjectPath, with a
 * distinct "-portrait" suffix so the cropped portrait's object never
 * collides with (or overwrites) the original, full passport image's own
 * object at buildApplicantPhotoObjectPath's path for the SAME message —
 * both coexist as independent objects in the same bucket.
 */
export function buildApplicantPortraitObjectPath(telegramMessageId: string, mimeType: string): string {
  return `visa-photos/${telegramMessageId}-portrait.${extensionForMimeType(mimeType)}`;
}

/**
 * Uploads the CROPPED applicant portrait (see extractApplicantPhotoCrop.ts)
 * as an artifact fully independent from uploadApplicantPhoto's own original,
 * full passport image — same bucket, same storage config, same "null means
 * not configured/failed, never an error" contract, but a distinct object
 * path (buildApplicantPortraitObjectPath) so neither upload can ever
 * overwrite the other. Callers must never pass the original, uncropped
 * buffer here, and must never let a failure here affect the original
 * photo's own upload.
 */
export async function uploadApplicantPortrait(
  input: UploadApplicantPhotoInput,
  deps: UploadApplicantPhotoDependencies = defaultDependencies,
): Promise<string | null> {
  if (!deps.config) {
    return null;
  }
  const objectPath = buildApplicantPortraitObjectPath(input.telegramMessageId, input.mimeType);
  const file = deps.getBucket(deps.config).file(objectPath);
  await file.save(input.buffer, { contentType: input.mimeType, resumable: false });
  return objectPath;
}
