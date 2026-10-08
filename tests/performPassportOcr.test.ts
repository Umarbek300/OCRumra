import assert from 'node:assert/strict';
import { test } from 'node:test';
import { performPassportOcr, type PerformPassportOcrDependencies } from '../src/worker/performPassportOcr.js';
import type { PassportExtractionResult } from '../src/ocr/passportExtractionSchema.js';
import type { PassportOcrResultRecord } from '../src/db/repositories/passportOcrResult.repo.js';

const CONTEXT = {
  telegramMessageId: '11111111-1111-1111-1111-111111111111',
  telegramPhotoFileId: 'FILE_ABC',
  groupId: '22222222-2222-2222-2222-222222222222',
  agentId: '33333333-3333-3333-3333-333333333333',
};

function field(value: string | null = null, confidence: 'high' | 'medium' | 'low' | null = null) {
  return { value, confidence };
}

function genderField(value: 'male' | 'female' | 'unspecified' | null = null, confidence: 'high' | 'medium' | 'low' | null = null) {
  return { value, confidence };
}

function sampleExtraction(): PassportExtractionResult {
  return {
    firstName: field('Jane', 'high'),
    middleName: field(),
    surname: field('Doe', 'high'),
    passportNumber: field('X1234567', 'high'),
    dateOfBirth: field('1990-05-15', 'high'),
    passportIssueDate: field('2020-01-01', 'high'),
    passportExpiryDate: field('2030-01-01', 'high'),
    gender: genderField('female', 'high'),
    nationality: field('UZB', 'high'),
    placeOfBirth: field(),
    issuingAuthority: field(),
    mrz: field(),
    overallConfidence: 'high',
    model: 'claude-opus-5',
  };
}

function buildDeps(overrides: Partial<PerformPassportOcrDependencies> = {}): {
  deps: PerformPassportOcrDependencies;
  calls: {
    findExisting: number;
    download: number;
    extract: number;
    detectFaces: number;
    buildCanonicalImage: number;
    upload: number;
    extractPhotoCrop: number;
    uploadPortrait: number;
    generateToken: number;
    save: number;
    enqueueSheetSync: number;
    resolveIdentity: number;
  };
  savedInputs: Array<Parameters<PerformPassportOcrDependencies['saveResult']>[0]>;
} {
  const calls = {
    findExisting: 0,
    download: 0,
    extract: 0,
    detectFaces: 0,
    buildCanonicalImage: 0,
    upload: 0,
    extractPhotoCrop: 0,
    uploadPortrait: 0,
    generateToken: 0,
    save: 0,
    enqueueSheetSync: 0,
    resolveIdentity: 0,
  };
  const savedInputs: Array<Parameters<PerformPassportOcrDependencies['saveResult']>[0]> = [];
  let tokenCounter = 0;
  const deps: PerformPassportOcrDependencies = {
    // Duplicate-passport identity resolution is a separate feature with
    // its own dedicated test suite (tests/duplicates.*.test.ts) — these
    // pre-existing OCR-pipeline tests fake it out to a benign default
    // (never touching a real DB, never suppressing the sheet-sync enqueue)
    // so this file's own assertions stay exactly as they were.
    resolveIdentity: async () => {
      calls.resolveIdentity += 1;
      return { kind: 'NO_IDENTITY_DATA' };
    },
    findExistingResult: async () => {
      calls.findExisting += 1;
      return null;
    },
    downloadPhoto: async () => {
      calls.download += 1;
      return { buffer: Buffer.from('fake-image-bytes'), mimeType: 'image/jpeg' };
    },
    extract: async () => {
      calls.extract += 1;
      return sampleExtraction();
    },
    // Default: no faces found (an empty array, same shape a real "no face
    // in this photo" Vision response has — never a guess). Individual
    // tests override this to simulate a successful detection.
    detectFaces: async () => {
      calls.detectFaces += 1;
      return { faces: [] };
    },
    // Default: echoes the buffer it was given back unchanged — the same
    // "safe fallback, no boundary detected" behavior the REAL
    // buildCanonicalPassportImage has when it can't confidently isolate the
    // passport. Individual tests override this to simulate a genuine crop.
    buildCanonicalImage: async (buffer) => {
      calls.buildCanonicalImage += 1;
      return { buffer, width: 0, height: 0, boundary: null };
    },
    uploadPhoto: async () => {
      calls.upload += 1;
      return 'visa-photos/11111111-1111-1111-1111-111111111111.jpg';
    },
    extractPhotoCrop: async () => {
      calls.extractPhotoCrop += 1;
      return Buffer.from('fake-cropped-portrait-bytes');
    },
    uploadPortrait: async () => {
      calls.uploadPortrait += 1;
      return 'visa-photos/11111111-1111-1111-1111-111111111111-portrait.jpg';
    },
    // Called independently for the original photo's token and the
    // portrait's token — a shared fake counter lets tests distinguish
    // "called once" from "called twice" without the two calls colliding
    // on the exact same returned string.
    generateToken: () => {
      calls.generateToken += 1;
      tokenCounter += 1;
      return `fake-token-${tokenCounter}`;
    },
    saveResult: async (input) => {
      calls.save += 1;
      savedInputs.push(input);
      return { id: 'result-id', createdAt: 'now', updatedAt: 'now', ...input } as PassportOcrResultRecord;
    },
    enqueueSheetSync: async (telegramMessageId) => {
      calls.enqueueSheetSync += 1;
      return { id: 'sheet-sync-id', telegramMessageId } as never;
    },
    ...overrides,
  };
  return { deps, calls, savedInputs };
}

test('performPassportOcr downloads, extracts, and saves for a message with no existing result', async () => {
  const { deps, calls } = buildDeps();
  await performPassportOcr(CONTEXT, deps);

  assert.equal(calls.findExisting, 1);
  assert.equal(calls.download, 1);
  assert.equal(calls.extract, 1);
  assert.equal(calls.save, 1);
});

test('performPassportOcr skips calling Claude when an OCR result already exists (idempotency)', async () => {
  const { deps, calls } = buildDeps({
    findExistingResult: async () => {
      calls.findExisting += 1;
      return { id: 'existing', telegramMessageId: CONTEXT.telegramMessageId } as unknown as PassportOcrResultRecord;
    },
  });

  await performPassportOcr(CONTEXT, deps);

  assert.equal(calls.findExisting, 1);
  assert.equal(calls.download, 0, 'must not download the photo again');
  assert.equal(calls.extract, 0, 'must not call Claude again');
  assert.equal(calls.save, 0, 'must not attempt to save again');
});

test('performPassportOcr propagates a Telegram download failure', async () => {
  const { deps, calls } = buildDeps({
    downloadPhoto: async () => {
      calls.download += 1;
      throw new Error('Failed to download Telegram file: Telegram returned HTTP 404');
    },
  });

  await assert.rejects(() => performPassportOcr(CONTEXT, deps), /Failed to download Telegram file/);
  assert.equal(calls.extract, 0, 'must not call Claude if the download failed');
  assert.equal(calls.save, 0);
  assert.equal(calls.enqueueSheetSync, 0, 'must not queue a sheet sync for a message that never got an OCR result');
});

test('performPassportOcr propagates a Claude extraction failure', async () => {
  const { deps, calls } = buildDeps({
    extract: async () => {
      calls.extract += 1;
      throw new Error('Claude Vision request failed: rate limited');
    },
  });

  await assert.rejects(() => performPassportOcr(CONTEXT, deps), /Claude Vision request failed/);
  assert.equal(calls.save, 0, 'must not save a result when extraction failed');
  assert.equal(calls.enqueueSheetSync, 0, 'must not queue a sheet sync for a message that never got an OCR result');
});

test('performPassportOcr treats a concurrent-insert race as benign (does not throw)', async () => {
  const { deps } = buildDeps({
    saveResult: async () => null, // ON CONFLICT DO NOTHING — another worker already stored it
  });

  await assert.doesNotReject(() => performPassportOcr(CONTEXT, deps));
});

test('performPassportOcr enqueues a sheet sync job after a fresh save', async () => {
  const { deps, calls } = buildDeps();
  await performPassportOcr(CONTEXT, deps);

  assert.equal(calls.enqueueSheetSync, 1);
});

test('performPassportOcr enqueues a sheet sync job even when the OCR result already existed (idempotent safety net for pre-existing results)', async () => {
  const { deps, calls } = buildDeps({
    findExistingResult: async () => {
      calls.findExisting += 1;
      return { id: 'existing', telegramMessageId: CONTEXT.telegramMessageId } as unknown as PassportOcrResultRecord;
    },
  });

  await performPassportOcr(CONTEXT, deps);

  assert.equal(calls.enqueueSheetSync, 1);
});

test('performPassportOcr enqueues a sheet sync job even when saveResult raced with another worker', async () => {
  const { deps, calls } = buildDeps({
    saveResult: async () => null,
  });

  await performPassportOcr(CONTEXT, deps);

  assert.equal(calls.enqueueSheetSync, 1);
});

test('a sheet-sync queue failure never fails performPassportOcr — OCR success is unaffected', async () => {
  const { deps, calls } = buildDeps({
    enqueueSheetSync: async () => {
      calls.enqueueSheetSync += 1;
      throw new Error('sheet_sync_queue insert failed: connection reset');
    },
  });

  await assert.doesNotReject(() => performPassportOcr(CONTEXT, deps));
  assert.equal(calls.save, 1, 'the OCR result must still have been saved successfully');
  assert.equal(calls.enqueueSheetSync, 1, 'the enqueue was attempted, just never allowed to propagate');
});

// --- duplicate-passport identity resolution integration (see src/duplicates/) ---

test('performPassportOcr suppresses the sheet-sync enqueue when identity resolution flags a REVIEW', async () => {
  const { deps, calls } = buildDeps({
    resolveIdentity: async () => {
      calls.resolveIdentity += 1;
      return { kind: 'REVIEW' };
    },
  });

  await performPassportOcr(CONTEXT, deps);

  assert.equal(calls.save, 1, 'the OCR result must still be saved even when flagged for review');
  assert.equal(calls.enqueueSheetSync, 0, 'a REVIEW-flagged message must never be written to the Sheet until an operator resolves it');
});

test('performPassportOcr proceeds with the sheet-sync enqueue when identity resolution returns LINKED', async () => {
  const { deps, calls } = buildDeps({
    resolveIdentity: async () => {
      calls.resolveIdentity += 1;
      return { kind: 'LINKED', identityId: 'identity-1', role: 'canonical' };
    },
  });

  await performPassportOcr(CONTEXT, deps);

  assert.equal(calls.enqueueSheetSync, 1);
});

test('performPassportOcr proceeds with the sheet-sync enqueue when identity resolution returns ALREADY_RESOLVED', async () => {
  const { deps, calls } = buildDeps({
    resolveIdentity: async () => {
      calls.resolveIdentity += 1;
      return { kind: 'ALREADY_RESOLVED', role: 'duplicate' };
    },
  });

  await performPassportOcr(CONTEXT, deps);

  assert.equal(calls.enqueueSheetSync, 1);
});

test('an identity-resolution failure never fails performPassportOcr and does not suppress sheet sync', async () => {
  const { deps, calls } = buildDeps({
    resolveIdentity: async () => {
      calls.resolveIdentity += 1;
      throw new Error('passport_identity insert failed: connection reset');
    },
  });

  await assert.doesNotReject(() => performPassportOcr(CONTEXT, deps));
  assert.equal(calls.save, 1);
  assert.equal(calls.enqueueSheetSync, 1, 'sheet sync must proceed as if duplicate detection did not run');
});

test('performPassportOcr passes the existing result\'s passport/DOB fields to identity resolution on the idempotent (already-exists) path', async () => {
  let receivedPassportNumber: unknown;
  let receivedDob: unknown;
  const { deps, calls } = buildDeps({
    findExistingResult: async () => {
      calls.findExisting += 1;
      return {
        id: 'existing',
        telegramMessageId: CONTEXT.telegramMessageId,
        passportNumber: { value: 'X1234567', confidence: 'high' },
        dateOfBirth: { value: '1990-05-15', confidence: 'high' },
      } as unknown as import('../src/db/repositories/passportOcrResult.repo.js').PassportOcrResultRecord;
    },
    resolveIdentity: async (input) => {
      calls.resolveIdentity += 1;
      receivedPassportNumber = input.passportNumber;
      receivedDob = input.dateOfBirth;
      return { kind: 'NO_IDENTITY_DATA' };
    },
  });

  await performPassportOcr(CONTEXT, deps);

  assert.deepEqual(receivedPassportNumber, { value: 'X1234567', confidence: 'high' });
  assert.deepEqual(receivedDob, { value: '1990-05-15', confidence: 'high' });
});

// --- CANONICAL passport-only image upload (src/visa/uploadApplicantPhoto.ts's
// uploadApplicantPhoto, src/visa/buildCanonicalPassportImage.ts) ---
// T column no longer stores the raw, untouched Telegram buffer: it stores
// whatever buildCanonicalImage produces (document-boundary isolation, EXIF-
// normalized — a genuine crop when a background/hand-held photo is reliably
// detected, or the full normalized image as a safe fallback otherwise). This
// is independent of, and never replaced by, the portrait artifact (see the
// portrait section further below, which is a fully separate, independent
// flow) and never a second Telegram fetch.

test('performPassportOcr uploads whatever buildCanonicalImage returns, not necessarily the raw original bytes', async () => {
  const uploadedBuffers: Buffer[] = [];
  const canonicalBuffer = Buffer.from('canonical-passport-only-bytes');
  const receivedCanonicalInputs: Array<{ buffer: Buffer; faces: unknown; pages: unknown }> = [];
  const { deps, calls } = buildDeps({
    extract: async () => ({ ...sampleExtraction(), visionPages: [{ width: 100, height: 100 }] }) as PassportExtractionResult,
    detectFaces: async () => {
      calls.detectFaces += 1;
      return { faces: [{ detectionConfidence: 0.9 }] };
    },
    buildCanonicalImage: async (buffer, faces, pages) => {
      calls.buildCanonicalImage += 1;
      receivedCanonicalInputs.push({ buffer, faces, pages });
      return { buffer: canonicalBuffer, width: 10, height: 10, boundary: null };
    },
    uploadPhoto: async (input) => {
      calls.upload += 1;
      uploadedBuffers.push(input.buffer);
      return 'visa-photos/11111111-1111-1111-1111-111111111111.jpg';
    },
  });

  await performPassportOcr(CONTEXT, deps);

  assert.equal(calls.detectFaces, 1, 'face detection must happen exactly once (shared, never duplicated)');
  assert.equal(calls.buildCanonicalImage, 1);
  assert.equal(receivedCanonicalInputs[0]?.buffer.toString(), 'fake-image-bytes', 'buildCanonicalImage must receive the exact original downloaded buffer');
  assert.deepEqual(receivedCanonicalInputs[0]?.faces, [{ detectionConfidence: 0.9 }], 'buildCanonicalImage must receive the SAME faces the shared detectFaces call found');
  assert.deepEqual(receivedCanonicalInputs[0]?.pages, [{ width: 100, height: 100 }], 'buildCanonicalImage must receive extraction.visionPages');
  assert.equal(calls.upload, 1);
  assert.equal(uploadedBuffers.length, 1);
  assert.equal(uploadedBuffers[0]?.toString(), 'canonical-passport-only-bytes', 'uploadPhoto must receive buildCanonicalImage\'s output, not the raw original buffer');
});

test('performPassportOcr falls back to uploading the full (buildCanonicalImage-returned) buffer when no reliable document boundary exists -- the default, safe-fallback mock behavior', async () => {
  const uploadedBuffers: Buffer[] = [];
  const { deps, calls } = buildDeps({
    uploadPhoto: async (input) => {
      calls.upload += 1;
      uploadedBuffers.push(input.buffer);
      return 'visa-photos/11111111-1111-1111-1111-111111111111.jpg';
    },
  });

  await performPassportOcr(CONTEXT, deps);

  assert.equal(calls.upload, 1);
  assert.equal(uploadedBuffers[0]?.toString(), 'fake-image-bytes', 'with the default (pass-through) buildCanonicalImage mock, the fallback is byte-identical to the original');
});

test('performPassportOcr shares ONE detectFaces call between buildCanonicalImage and extractPhotoCrop -- never detects faces twice for the same message', async () => {
  const { deps, calls } = buildDeps();

  await performPassportOcr(CONTEXT, deps);

  assert.equal(calls.detectFaces, 1, 'exactly one shared Vision FACE_DETECTION call per message');
});

test('a shared face-detection failure never fails performPassportOcr, never blocks the canonical-image or portrait steps, and both fall back safely', async () => {
  const { deps, calls, savedInputs } = buildDeps({
    detectFaces: async () => {
      calls.detectFaces += 1;
      throw new Error('Google Vision face detection call failed: 7 PERMISSION_DENIED');
    },
  });

  await assert.doesNotReject(() => performPassportOcr(CONTEXT, deps));
  assert.equal(calls.buildCanonicalImage, 1, 'the canonical-image step must still be attempted, with no precomputed faces');
  assert.equal(calls.upload, 1, 'the photo upload must still be attempted');
  assert.ok(savedInputs[0]?.personalPhotoObjectPath, 'a photo path must still be saved despite the face-detection failure');
});

test('performPassportOcr passes the shared detected faces through to extractPhotoCrop as its 5th argument', async () => {
  const receivedFaces: unknown[] = [];
  const sharedFaceList = [{ detectionConfidence: 0.95 }];
  const { deps } = buildDeps({
    detectFaces: async () => ({ faces: sharedFaceList }),
    extractPhotoCrop: async (buffer, mimeType, depsArg, pages, faces) => {
      receivedFaces.push(faces);
      return Buffer.from('fake-cropped-portrait-bytes');
    },
  });

  await performPassportOcr(CONTEXT, deps);

  assert.deepEqual(receivedFaces[0], sharedFaceList);
});

test('performPassportOcr always attempts the original-photo upload, even when extractPhotoCrop finds no reliable portrait region', async () => {
  const { deps, calls, savedInputs } = buildDeps({
    extractPhotoCrop: async () => {
      calls.extractPhotoCrop += 1;
      return null;
    },
  });

  await performPassportOcr(CONTEXT, deps);

  assert.equal(calls.upload, 1, 'the original passport image must still be uploaded regardless of portrait crop outcome');
  assert.ok(savedInputs[0]?.personalPhotoObjectPath, 'the original photo path must still be saved');
});

test('a photo upload failure never fails performPassportOcr — the OCR result is still saved, with a null photo path', async () => {
  const { deps, calls, savedInputs } = buildDeps({
    uploadPhoto: async () => {
      calls.upload += 1;
      throw new Error('GCS upload failed: service unavailable');
    },
  });

  await assert.doesNotReject(() => performPassportOcr(CONTEXT, deps));
  assert.equal(calls.upload, 1);
  assert.equal(calls.save, 1, 'OCR must still succeed even though the photo upload failed');
  assert.equal(savedInputs[0]?.personalPhotoObjectPath, null);
});

test('performPassportOcr saves a null photo object path when photo storage is not configured (uploadPhoto resolves null)', async () => {
  const { deps, savedInputs } = buildDeps({
    uploadPhoto: async () => null,
  });

  await performPassportOcr(CONTEXT, deps);

  assert.equal(savedInputs[0]?.personalPhotoObjectPath, null);
});

test('performPassportOcr never attempts a photo upload on the idempotent (already-exists) path', async () => {
  const { deps, calls } = buildDeps({
    findExistingResult: async () => {
      calls.findExisting += 1;
      return { id: 'existing', telegramMessageId: CONTEXT.telegramMessageId } as unknown as PassportOcrResultRecord;
    },
  });

  await performPassportOcr(CONTEXT, deps);

  assert.equal(calls.upload, 0, 'must not re-upload a photo for a message whose OCR result already exists');
});

test('performPassportOcr persists the uploaded photo object path on the saved OCR result', async () => {
  const { deps, savedInputs } = buildDeps({
    uploadPhoto: async () => 'visa-photos/11111111-1111-1111-1111-111111111111.jpg',
  });

  await performPassportOcr(CONTEXT, deps);

  assert.equal(savedInputs[0]?.personalPhotoObjectPath, 'visa-photos/11111111-1111-1111-1111-111111111111.jpg');
});

test('performPassportOcr generates a photo token ONLY when the original-photo upload actually succeeds, and persists it alongside the object path', async () => {
  const { deps, calls, savedInputs } = buildDeps({
    uploadPhoto: async () => 'visa-photos/11111111-1111-1111-1111-111111111111.jpg',
  });

  await performPassportOcr(CONTEXT, deps);

  assert.ok(savedInputs[0]?.personalPhotoToken, 'a token must have been generated');
  assert.equal(savedInputs[0]?.personalPhotoObjectPath, 'visa-photos/11111111-1111-1111-1111-111111111111.jpg');
});

test('performPassportOcr never generates a photo token when the original-photo upload fails', async () => {
  const { deps, savedInputs } = buildDeps({
    uploadPhoto: async () => {
      throw new Error('GCS upload failed: service unavailable');
    },
  });

  await assert.doesNotReject(() => performPassportOcr(CONTEXT, deps));
  assert.equal(savedInputs[0]?.personalPhotoToken, null);
});

test('performPassportOcr never generates a photo token when photo storage is not configured (uploadPhoto resolves null)', async () => {
  const { deps, savedInputs } = buildDeps({
    uploadPhoto: async () => null,
  });

  await performPassportOcr(CONTEXT, deps);

  assert.equal(savedInputs[0]?.personalPhotoToken, null);
});

test('performPassportOcr never derives the photo token from telegramMessageId or any other identifier — it is exactly whatever generateToken returns', async () => {
  const { deps, savedInputs } = buildDeps({
    uploadPhoto: async () => 'visa-photos/11111111-1111-1111-1111-111111111111.jpg',
    generateToken: () => 'totally-unrelated-opaque-value',
  });

  await performPassportOcr(CONTEXT, deps);

  assert.equal(savedInputs[0]?.personalPhotoToken, 'totally-unrelated-opaque-value');
  assert.notEqual(savedInputs[0]?.personalPhotoToken, CONTEXT.telegramMessageId);
});

// --- CROPPED applicant portrait crop + upload (src/visa/extractApplicantPhotoCrop.ts, src/visa/uploadApplicantPhoto.ts's uploadApplicantPortrait) ---
// Fully independent from the original-photo upload above: its own buffer
// source (the same downloaded buffer, cropped), its own object path, its
// own token, its own DB fields. Never replaces, and is never replaced by,
// the original passport image.

test('performPassportOcr crops the portrait from the SAME downloaded buffer — never downloads a second time', async () => {
  const receivedBuffers: Buffer[] = [];
  const { deps, calls } = buildDeps({
    extractPhotoCrop: async (buffer) => {
      calls.extractPhotoCrop += 1;
      receivedBuffers.push(buffer);
      return Buffer.from('fake-cropped-portrait-bytes');
    },
  });

  await performPassportOcr(CONTEXT, deps);

  assert.equal(calls.download, 1, 'must download the photo exactly once');
  assert.equal(calls.extractPhotoCrop, 1);
  assert.equal(receivedBuffers.length, 1);
  assert.equal(receivedBuffers[0]?.toString(), 'fake-image-bytes', 'extractPhotoCrop must receive the exact buffer downloadPhoto returned');
});

test('performPassportOcr uploads the CROPPED portrait buffer via uploadPortrait, never via uploadPhoto', async () => {
  const uploadedBuffers: Buffer[] = [];
  const { deps, calls } = buildDeps({
    extractPhotoCrop: async () => {
      calls.extractPhotoCrop += 1;
      return Buffer.from('fake-cropped-portrait-bytes');
    },
    uploadPortrait: async (input) => {
      calls.uploadPortrait += 1;
      uploadedBuffers.push(input.buffer);
      return 'visa-photos/11111111-1111-1111-1111-111111111111-portrait.jpg';
    },
  });

  await performPassportOcr(CONTEXT, deps);

  assert.equal(calls.uploadPortrait, 1);
  assert.equal(calls.upload, 1, 'the original-photo upload still happens independently');
  assert.equal(uploadedBuffers.length, 1);
  assert.equal(uploadedBuffers[0]?.toString(), 'fake-cropped-portrait-bytes', 'uploadPortrait must receive the CROPPED buffer');
});

test('performPassportOcr never calls uploadPortrait when extractPhotoCrop finds no reliable portrait region (returns null), but still uploads the original photo', async () => {
  const { deps, calls, savedInputs } = buildDeps({
    extractPhotoCrop: async () => {
      calls.extractPhotoCrop += 1;
      return null;
    },
  });

  await performPassportOcr(CONTEXT, deps);

  assert.equal(calls.extractPhotoCrop, 1);
  assert.equal(calls.uploadPortrait, 0, 'must never upload a portrait when no reliable crop was found');
  assert.equal(calls.upload, 1, 'the original photo upload is unaffected');
  assert.equal(savedInputs[0]?.personalPortraitObjectPath, null);
  assert.equal(savedInputs[0]?.personalPortraitToken, null);
  assert.ok(savedInputs[0]?.personalPhotoObjectPath, 'the original photo path must still be saved');
});

test('a portrait crop failure (extractPhotoCrop throws, e.g. a Vision API infra error) never fails performPassportOcr, and never affects the original-photo upload', async () => {
  const { deps, calls, savedInputs } = buildDeps({
    extractPhotoCrop: async () => {
      calls.extractPhotoCrop += 1;
      throw new Error('Google Vision face detection call failed: 7 PERMISSION_DENIED');
    },
  });

  await assert.doesNotReject(() => performPassportOcr(CONTEXT, deps));
  assert.equal(calls.extractPhotoCrop, 1);
  assert.equal(calls.uploadPortrait, 0, 'must never fall back to uploading the original buffer as a portrait when cropping fails');
  assert.equal(calls.upload, 1, 'the original photo upload still happens independently');
  assert.equal(calls.save, 1, 'OCR must still succeed even though the portrait crop failed');
  assert.equal(savedInputs[0]?.personalPortraitObjectPath, null);
  assert.ok(savedInputs[0]?.personalPhotoObjectPath, 'the original photo path is unaffected by the portrait failure');
});

test('a portrait UPLOAD failure never fails performPassportOcr, and never affects the original-photo upload', async () => {
  const { deps, calls, savedInputs } = buildDeps({
    uploadPortrait: async () => {
      calls.uploadPortrait += 1;
      throw new Error('GCS upload failed: service unavailable');
    },
  });

  await assert.doesNotReject(() => performPassportOcr(CONTEXT, deps));
  assert.equal(calls.uploadPortrait, 1);
  assert.equal(calls.upload, 1, 'the original photo upload still happens independently');
  assert.equal(calls.save, 1);
  assert.equal(savedInputs[0]?.personalPortraitObjectPath, null);
  assert.ok(savedInputs[0]?.personalPhotoObjectPath, 'the original photo path is unaffected by the portrait failure');
});

test('performPassportOcr never attempts a portrait crop/upload on the idempotent (already-exists) path', async () => {
  const { deps, calls } = buildDeps({
    findExistingResult: async () => {
      calls.findExisting += 1;
      return { id: 'existing', telegramMessageId: CONTEXT.telegramMessageId } as unknown as PassportOcrResultRecord;
    },
  });

  await performPassportOcr(CONTEXT, deps);

  assert.equal(calls.extractPhotoCrop, 0, 'must not re-crop/re-upload a portrait for a message whose OCR result already exists');
  assert.equal(calls.uploadPortrait, 0);
});

test('performPassportOcr persists the uploaded portrait object path on the saved OCR result, independent from the photo object path', async () => {
  const { deps, savedInputs } = buildDeps();

  await performPassportOcr(CONTEXT, deps);

  assert.equal(savedInputs[0]?.personalPortraitObjectPath, 'visa-photos/11111111-1111-1111-1111-111111111111-portrait.jpg');
  assert.equal(savedInputs[0]?.personalPhotoObjectPath, 'visa-photos/11111111-1111-1111-1111-111111111111.jpg');
  assert.notEqual(
    savedInputs[0]?.personalPortraitObjectPath,
    savedInputs[0]?.personalPhotoObjectPath,
    'the portrait and the original photo must be two distinct objects',
  );
});

test('performPassportOcr generates a portrait token ONLY when the portrait upload actually succeeds, independent from the photo token', async () => {
  const { deps, savedInputs } = buildDeps();

  await performPassportOcr(CONTEXT, deps);

  assert.ok(savedInputs[0]?.personalPortraitToken, 'a portrait token must have been generated');
  assert.ok(savedInputs[0]?.personalPhotoToken, 'a photo token must also have been generated, independently');
  assert.notEqual(
    savedInputs[0]?.personalPortraitToken,
    savedInputs[0]?.personalPhotoToken,
    'the portrait token and the photo token must be two distinct, independently generated values',
  );
});

test('performPassportOcr never generates a portrait token when the portrait upload fails', async () => {
  const { deps, savedInputs } = buildDeps({
    uploadPortrait: async () => {
      throw new Error('GCS upload failed: service unavailable');
    },
  });

  await assert.doesNotReject(() => performPassportOcr(CONTEXT, deps));
  assert.equal(savedInputs[0]?.personalPortraitToken, null);
});

test('performPassportOcr never generates a portrait token when no reliable portrait region was found', async () => {
  const { deps, savedInputs } = buildDeps({
    extractPhotoCrop: async () => null,
  });

  await performPassportOcr(CONTEXT, deps);

  assert.equal(savedInputs[0]?.personalPortraitToken, null);
});

test('performPassportOcr never derives the portrait token from telegramMessageId or any other identifier', async () => {
  const { deps, savedInputs } = buildDeps({
    generateToken: () => 'totally-unrelated-portrait-value',
  });

  await performPassportOcr(CONTEXT, deps);

  assert.notEqual(savedInputs[0]?.personalPortraitToken, CONTEXT.telegramMessageId);
});

// --- layout-aware portrait crop: threading extraction.visionPages through ---
// (see src/visa/extractApplicantPhotoCrop.ts, src/ocr/providers/googleVisionProvider.ts)

test('performPassportOcr threads extraction.visionPages through to extractPhotoCrop as its 4th argument', async () => {
  const receivedArgs: unknown[] = [];
  const fakePages = [{ width: 100, height: 100 }];
  const { deps } = buildDeps({
    extract: async () => ({ ...sampleExtraction(), visionPages: fakePages }) as PassportExtractionResult,
    extractPhotoCrop: async (buffer, mimeType, depsArg, pages) => {
      receivedArgs.push(buffer, mimeType, depsArg, pages);
      return Buffer.from('fake-cropped-portrait-bytes');
    },
  });

  await performPassportOcr(CONTEXT, deps);

  assert.equal(receivedArgs.length, 4);
  assert.equal(receivedArgs[2], undefined, 'the deps slot is left undefined so extractApplicantPhotoCrop falls back to its own real default');
  assert.deepEqual(receivedArgs[3], fakePages);
});

test('performPassportOcr passes undefined (never an error) for extractPhotoCrop\'s layout-data argument when the provider never set visionPages (anthropic/local)', async () => {
  const receivedArgs: unknown[] = [];
  const { deps } = buildDeps({
    extract: async () => sampleExtraction(), // no visionPages field at all
    extractPhotoCrop: async (buffer, mimeType, depsArg, pages) => {
      receivedArgs.push(pages);
      return Buffer.from('fake-cropped-portrait-bytes');
    },
  });

  await performPassportOcr(CONTEXT, deps);

  assert.equal(receivedArgs[0], undefined);
});
