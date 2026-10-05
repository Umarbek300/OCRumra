import assert from 'node:assert/strict';
import { PassThrough, Readable } from 'node:stream';
import { test } from 'node:test';
import {
  handleApplicantPhotoRequest,
  type ApplicantPhotoRouteDependencies,
  type PhotoBucketLike,
  type PhotoRouteRequest,
} from '../src/visa/applicantPhotoRoute.js';
import type { ApplicantPhotoStorageConfig } from '../src/visa/uploadApplicantPhoto.js';
import type { OcrGenderValue, PassportOcrResultRecord } from '../src/db/repositories/passportOcrResult.repo.js';

/** A realistic generateApplicantPhotoToken.ts-shaped value — 43-char base64url, NOT a UUID. */
const REAL_TOKEN = 'xR7k2mQpL9vN4zT8wF1yB6hJ3cD0aE5sG2uK7iM9oPw';
/** A second, independent realistic token for the cropped portrait artifact — distinct from REAL_TOKEN, never derived from it. */
const REAL_PORTRAIT_TOKEN = 'qW3eR8tY5uI2oP9aS6dF1gH4jK7lZ0xC3vB6nM9kLq';
const TELEGRAM_MESSAGE_ID = '11111111-1111-1111-1111-111111111111';

const CONFIG: ApplicantPhotoStorageConfig = {
  bucketName: 'ocrumra-visa-photos',
  keyFilePath: '/etc/ocrumra/secrets/ocrumra-visa-photos-sa.json',
};

function ocrField<T extends string = string>(value: T | null = null) {
  return { value, confidence: value ? ('high' as const) : null };
}

function sampleOcrResult(overrides: Partial<PassportOcrResultRecord> = {}): PassportOcrResultRecord {
  return {
    id: 'ocr-1',
    telegramMessageId: TELEGRAM_MESSAGE_ID,
    personalPhotoObjectPath: 'visa-photos/11111111-1111-1111-1111-111111111111.jpg',
    personalPhotoToken: REAL_TOKEN,
    personalPortraitObjectPath: null,
    personalPortraitToken: null,
    firstName: ocrField(),
    middleName: ocrField(),
    surname: ocrField(),
    passportNumber: ocrField(),
    dateOfBirth: ocrField(),
    passportIssueDate: ocrField(),
    passportExpiryDate: ocrField(),
    gender: ocrField<OcrGenderValue>(),
    nationality: ocrField(),
    placeOfBirth: ocrField(),
    issuingAuthority: ocrField(),
    mrz: ocrField(),
    overallConfidence: 'high',
    rawResponse: {},
    provider: 'google-vision',
    model: 'google-vision-mrz',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** A minimal fake Express-like response: a real writable stream (so .pipe() works) plus the status/json/setHeader surface the handler needs. */
class FakeResponse extends PassThrough {
  statusCode = 200;
  headers: Record<string, string> = {};
  jsonBody: unknown = undefined;
  headersSent = false;
  receivedBytes: Buffer[] = [];

  constructor() {
    super();
    this.on('data', (chunk: Buffer) => this.receivedBytes.push(chunk));
  }

  status(code: number): this {
    this.statusCode = code;
    this.headersSent = true;
    return this;
  }

  json(body: unknown): void {
    this.jsonBody = body;
  }

  setHeader(name: string, value: string): void {
    this.headers[name] = value;
  }
}

/**
 * Default findOcrResult simulates a REAL token-column lookup: it only
 * "finds" a row when the requested value exactly equals the one row's own
 * personal_photo_token (REAL_TOKEN) — any other value, including a
 * perfectly well-formed telegram_message_id, simply matches nothing, same
 * as the real findPassportOcrResultByPersonalPhotoToken query would.
 */
function buildDeps(overrides: Partial<ApplicantPhotoRouteDependencies> = {}): ApplicantPhotoRouteDependencies {
  return {
    findOcrResult: async (token) => (token === REAL_TOKEN ? sampleOcrResult() : null),
    config: CONFIG,
    getBucket: () =>
      ({
        file: () => ({
          createReadStream: () => Readable.from([Buffer.from('fake-photo-bytes')]),
        }),
      }) as PhotoBucketLike,
    ...overrides,
  };
}

function req(token: string | undefined): PhotoRouteRequest {
  return { params: { token } };
}

async function waitForStreamEnd(res: FakeResponse): Promise<void> {
  await new Promise<void>((resolve) => res.on('end', resolve));
}

test('handleApplicantPhotoRequest rejects a malformed (wrong-shape) token with 400, never touching the DB', async () => {
  let dbCalled = false;
  const res = new FakeResponse();
  await handleApplicantPhotoRequest(req('too-short'), res, buildDeps({ findOcrResult: async () => { dbCalled = true; return null; } }));

  assert.equal(res.statusCode, 400);
  assert.equal(dbCalled, false, 'a malformed token must be rejected before any DB lookup');
});

test('handleApplicantPhotoRequest rejects a missing token with 400', async () => {
  const res = new FakeResponse();
  await handleApplicantPhotoRequest(req(undefined), res, buildDeps());

  assert.equal(res.statusCode, 400);
});

test('handleApplicantPhotoRequest returns 503 when photo storage is not configured', async () => {
  const res = new FakeResponse();
  await handleApplicantPhotoRequest(req(REAL_TOKEN), res, buildDeps({ config: null }));

  assert.equal(res.statusCode, 503);
});

test('handleApplicantPhotoRequest returns 404 when no OCR result matches the token', async () => {
  const res = new FakeResponse();
  await handleApplicantPhotoRequest(req(REAL_TOKEN), res, buildDeps({ findOcrResult: async () => null }));

  assert.equal(res.statusCode, 404);
});

test('handleApplicantPhotoRequest REJECTS a telegram_message_id passed as the token — it must never be accepted as a substitute', async () => {
  const res = new FakeResponse();
  // TELEGRAM_MESSAGE_ID is well-formed (passes the shape check: 36 hex/hyphen
  // chars, within [32,128]) and belongs to the SAME row as REAL_TOKEN — this
  // proves rejection comes from the token-column lookup itself, not merely
  // from an unrelated/unknown value.
  await handleApplicantPhotoRequest(req(TELEGRAM_MESSAGE_ID), res, buildDeps());

  assert.equal(res.statusCode, 404, 'a telegram_message_id must never work as a photo token, even though it is well-formed and belongs to a real row');
});

test('handleApplicantPhotoRequest returns 404 when the OCR result exists but has no photo object path yet', async () => {
  const res = new FakeResponse();
  await handleApplicantPhotoRequest(
    req(REAL_TOKEN),
    res,
    buildDeps({ findOcrResult: async (token) => (token === REAL_TOKEN ? sampleOcrResult({ personalPhotoObjectPath: null }) : null) }),
  );

  assert.equal(res.statusCode, 404);
});

test('handleApplicantPhotoRequest serves the CROPPED PORTRAIT object when the requested token matches personal_portrait_token, not personal_photo_token', async () => {
  const res = new FakeResponse();
  const row = sampleOcrResult({
    personalPhotoObjectPath: 'visa-photos/11111111-1111-1111-1111-111111111111.jpg',
    personalPhotoToken: REAL_TOKEN,
    personalPortraitObjectPath: 'visa-photos/11111111-1111-1111-1111-111111111111-portrait.jpg',
    personalPortraitToken: REAL_PORTRAIT_TOKEN,
  });
  let requestedObjectPath: string | undefined;
  await handleApplicantPhotoRequest(
    req(REAL_PORTRAIT_TOKEN),
    res,
    buildDeps({
      findOcrResult: async (token) => (token === REAL_PORTRAIT_TOKEN || token === REAL_TOKEN ? row : null),
      getBucket: () =>
        ({
          file: (objectPath: string) => {
            requestedObjectPath = objectPath;
            return { createReadStream: () => Readable.from([Buffer.from('fake-portrait-bytes')]) };
          },
        }) as PhotoBucketLike,
    }),
  );
  await waitForStreamEnd(res);

  assert.equal(requestedObjectPath, 'visa-photos/11111111-1111-1111-1111-111111111111-portrait.jpg');
  assert.equal(Buffer.concat(res.receivedBytes).toString(), 'fake-portrait-bytes');
});

test('handleApplicantPhotoRequest still serves the ORIGINAL passport object for the same row when requested by its own personal_photo_token', async () => {
  const res = new FakeResponse();
  const row = sampleOcrResult({
    personalPhotoObjectPath: 'visa-photos/11111111-1111-1111-1111-111111111111.jpg',
    personalPhotoToken: REAL_TOKEN,
    personalPortraitObjectPath: 'visa-photos/11111111-1111-1111-1111-111111111111-portrait.jpg',
    personalPortraitToken: REAL_PORTRAIT_TOKEN,
  });
  let requestedObjectPath: string | undefined;
  await handleApplicantPhotoRequest(
    req(REAL_TOKEN),
    res,
    buildDeps({
      findOcrResult: async (token) => (token === REAL_PORTRAIT_TOKEN || token === REAL_TOKEN ? row : null),
      getBucket: () =>
        ({
          file: (objectPath: string) => {
            requestedObjectPath = objectPath;
            return { createReadStream: () => Readable.from([Buffer.from('fake-photo-bytes')]) };
          },
        }) as PhotoBucketLike,
    }),
  );
  await waitForStreamEnd(res);

  assert.equal(requestedObjectPath, 'visa-photos/11111111-1111-1111-1111-111111111111.jpg');
});

test('handleApplicantPhotoRequest returns 404 when the portrait token matches but personal_portrait_object_path is somehow null', async () => {
  const res = new FakeResponse();
  await handleApplicantPhotoRequest(
    req(REAL_PORTRAIT_TOKEN),
    res,
    buildDeps({
      findOcrResult: async (token) =>
        token === REAL_PORTRAIT_TOKEN
          ? sampleOcrResult({ personalPortraitToken: REAL_PORTRAIT_TOKEN, personalPortraitObjectPath: null })
          : null,
    }),
  );

  assert.equal(res.statusCode, 404);
});

test('handleApplicantPhotoRequest returns 500 (not the raw error) when the DB lookup itself fails', async () => {
  const res = new FakeResponse();
  await handleApplicantPhotoRequest(
    req(REAL_TOKEN),
    res,
    buildDeps({
      findOcrResult: async () => {
        throw new Error('connection reset');
      },
    }),
  );

  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.jsonBody, { error: 'internal error' });
});

test('handleApplicantPhotoRequest streams the photo bytes with the correct content type for a found photo', async () => {
  const res = new FakeResponse();
  await handleApplicantPhotoRequest(req(REAL_TOKEN), res, buildDeps());
  await waitForStreamEnd(res);

  assert.equal(res.headers['Content-Type'], 'image/jpeg');
  assert.equal(Buffer.concat(res.receivedBytes).toString(), 'fake-photo-bytes');
});

test('handleApplicantPhotoRequest infers content type from the object path extension', async () => {
  const res = new FakeResponse();
  await handleApplicantPhotoRequest(
    req(REAL_TOKEN),
    res,
    buildDeps({
      findOcrResult: async (token) =>
        token === REAL_TOKEN ? sampleOcrResult({ personalPhotoObjectPath: 'visa-photos/11111111-1111-1111-1111-111111111111.png' }) : null,
    }),
  );
  await waitForStreamEnd(res);

  assert.equal(res.headers['Content-Type'], 'image/png');
});

test('handleApplicantPhotoRequest never exposes the bucket name, object path, or telegram_message_id in any response body', async () => {
  const res = new FakeResponse();
  await handleApplicantPhotoRequest(req(REAL_TOKEN), res, buildDeps());
  await waitForStreamEnd(res);

  const serialized = JSON.stringify(res.jsonBody ?? '') + Object.values(res.headers).join(' ');
  assert.ok(!serialized.includes('ocrumra-visa-photos'), 'bucket name must never appear in the response');
  assert.ok(!serialized.includes('visa-photos/11111111'), 'the raw GCS object path must never appear in the response');
  assert.ok(!serialized.includes(TELEGRAM_MESSAGE_ID), 'telegram_message_id must never appear in the response');
});

test('handleApplicantPhotoRequest returns 404 (not a raw stream error) when the storage read fails before any bytes are sent', async () => {
  const res = new FakeResponse();
  await handleApplicantPhotoRequest(
    req(REAL_TOKEN),
    res,
    buildDeps({
      getBucket: () =>
        ({
          file: () => ({
            createReadStream: () => {
              const stream = new PassThrough();
              queueMicrotask(() => stream.emit('error', new Error('object not found in bucket')));
              return stream;
            },
          }),
        }) as PhotoBucketLike,
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(res.statusCode, 404);
});
