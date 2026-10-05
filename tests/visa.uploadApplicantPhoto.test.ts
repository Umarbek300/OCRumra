import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildApplicantPhotoObjectPath,
  buildApplicantPortraitObjectPath,
  resolveApplicantPhotoStorageConfig,
  uploadApplicantPhoto,
  uploadApplicantPortrait,
  type ApplicantPhotoStorageConfig,
  type UploadApplicantPhotoDependencies,
} from '../src/visa/uploadApplicantPhoto.js';

const CONFIG: ApplicantPhotoStorageConfig = {
  bucketName: 'ocrumra-visa-photos',
  keyFilePath: '/etc/ocrumra/secrets/ocrumra-visa-photos-sa.json',
};

test('buildApplicantPhotoObjectPath keys the object by telegram_message_id, never by passport number or name', () => {
  const path = buildApplicantPhotoObjectPath('11111111-1111-1111-1111-111111111111', 'image/jpeg');
  assert.equal(path, 'visa-photos/11111111-1111-1111-1111-111111111111.jpg');
});

test('buildApplicantPhotoObjectPath picks the extension from the mime type', () => {
  assert.equal(buildApplicantPhotoObjectPath('id-1', 'image/png'), 'visa-photos/id-1.png');
  assert.equal(buildApplicantPhotoObjectPath('id-1', 'image/webp'), 'visa-photos/id-1.webp');
  assert.equal(buildApplicantPhotoObjectPath('id-1', 'image/gif'), 'visa-photos/id-1.gif');
});

test('buildApplicantPhotoObjectPath falls back to .jpg for an unrecognized mime type', () => {
  assert.equal(buildApplicantPhotoObjectPath('id-1', 'application/octet-stream'), 'visa-photos/id-1.jpg');
});

test('resolveApplicantPhotoStorageConfig returns null when the bucket is not configured', () => {
  const config = resolveApplicantPhotoStorageConfig({ GCS_VISA_PHOTOS_SERVICE_ACCOUNT_KEY_FILE: '/path/to/key.json' });
  assert.equal(config, null);
});

test('resolveApplicantPhotoStorageConfig returns null when the key file path is not configured', () => {
  const config = resolveApplicantPhotoStorageConfig({ GCS_VISA_PHOTOS_BUCKET: 'ocrumra-visa-photos' });
  assert.equal(config, null);
});

test('resolveApplicantPhotoStorageConfig returns the config when both vars are set', () => {
  const config = resolveApplicantPhotoStorageConfig({
    GCS_VISA_PHOTOS_BUCKET: 'ocrumra-visa-photos',
    GCS_VISA_PHOTOS_SERVICE_ACCOUNT_KEY_FILE: '/etc/ocrumra/secrets/ocrumra-visa-photos-sa.json',
  });
  assert.deepEqual(config, {
    bucketName: 'ocrumra-visa-photos',
    keyFilePath: '/etc/ocrumra/secrets/ocrumra-visa-photos-sa.json',
  });
});

interface FakeFile {
  path: string;
  save(buffer: Buffer, options: { contentType: string; resumable: boolean }): Promise<void>;
}

function buildFakeDeps(overrides: Partial<UploadApplicantPhotoDependencies> = {}): {
  deps: UploadApplicantPhotoDependencies;
  savedCalls: Array<{ objectPath: string; buffer: Buffer; contentType: string }>;
} {
  const savedCalls: Array<{ objectPath: string; buffer: Buffer; contentType: string }> = [];
  const deps: UploadApplicantPhotoDependencies = {
    config: CONFIG,
    getBucket: () =>
      ({
        file: (objectPath: string): FakeFile => ({
          path: objectPath,
          save: async (buffer, options) => {
            savedCalls.push({ objectPath, buffer, contentType: options.contentType });
          },
        }),
      }) as unknown as ReturnType<UploadApplicantPhotoDependencies['getBucket']>,
    ...overrides,
  };
  return { deps, savedCalls };
}

test('uploadApplicantPhoto returns null (never throws) when photo storage is not configured', async () => {
  const result = await uploadApplicantPhoto(
    { telegramMessageId: 'id-1', buffer: Buffer.from('bytes'), mimeType: 'image/jpeg' },
    { config: null, getBucket: () => { throw new Error('must never be called when config is null'); } },
  );
  assert.equal(result, null);
});

test('uploadApplicantPhoto uploads the buffer to the correct object path and returns it', async () => {
  const { deps, savedCalls } = buildFakeDeps();
  const result = await uploadApplicantPhoto(
    { telegramMessageId: '11111111-1111-1111-1111-111111111111', buffer: Buffer.from('fake-image-bytes'), mimeType: 'image/jpeg' },
    deps,
  );

  assert.equal(result, 'visa-photos/11111111-1111-1111-1111-111111111111.jpg');
  assert.equal(savedCalls.length, 1);
  assert.equal(savedCalls[0]?.objectPath, 'visa-photos/11111111-1111-1111-1111-111111111111.jpg');
  assert.equal(savedCalls[0]?.buffer.toString(), 'fake-image-bytes');
  assert.equal(savedCalls[0]?.contentType, 'image/jpeg');
});

test('uploadApplicantPhoto propagates a real storage failure to its caller (performPassportOcr.ts is responsible for catching it)', async () => {
  const deps: UploadApplicantPhotoDependencies = {
    config: CONFIG,
    getBucket: () =>
      ({
        file: () => ({
          save: async () => {
            throw new Error('GCS upload failed: service unavailable');
          },
        }),
      }) as unknown as ReturnType<UploadApplicantPhotoDependencies['getBucket']>,
  };

  await assert.rejects(
    () => uploadApplicantPhoto({ telegramMessageId: 'id-1', buffer: Buffer.from('bytes'), mimeType: 'image/jpeg' }, deps),
    /GCS upload failed/,
  );
});

// --- cropped portrait (buildApplicantPortraitObjectPath / uploadApplicantPortrait) ---
// A SEPARATE artifact from the original photo above: distinct object path
// (never collides with buildApplicantPhotoObjectPath's own path for the
// SAME message), same storage config/bucket, same "null means not
// configured/failed, never an error" contract.

test('buildApplicantPortraitObjectPath keys the object by telegram_message_id, with a distinct "-portrait" suffix', () => {
  const path = buildApplicantPortraitObjectPath('11111111-1111-1111-1111-111111111111', 'image/jpeg');
  assert.equal(path, 'visa-photos/11111111-1111-1111-1111-111111111111-portrait.jpg');
});

test('buildApplicantPortraitObjectPath never collides with buildApplicantPhotoObjectPath for the same message', () => {
  const telegramMessageId = '11111111-1111-1111-1111-111111111111';
  const photoPath = buildApplicantPhotoObjectPath(telegramMessageId, 'image/jpeg');
  const portraitPath = buildApplicantPortraitObjectPath(telegramMessageId, 'image/jpeg');
  assert.notEqual(photoPath, portraitPath);
});

test('buildApplicantPortraitObjectPath picks the extension from the mime type', () => {
  assert.equal(buildApplicantPortraitObjectPath('id-1', 'image/png'), 'visa-photos/id-1-portrait.png');
  assert.equal(buildApplicantPortraitObjectPath('id-1', 'image/webp'), 'visa-photos/id-1-portrait.webp');
  assert.equal(buildApplicantPortraitObjectPath('id-1', 'image/gif'), 'visa-photos/id-1-portrait.gif');
});

test('buildApplicantPortraitObjectPath falls back to .jpg for an unrecognized mime type', () => {
  assert.equal(buildApplicantPortraitObjectPath('id-1', 'application/octet-stream'), 'visa-photos/id-1-portrait.jpg');
});

test('uploadApplicantPortrait returns null (never throws) when photo storage is not configured', async () => {
  const result = await uploadApplicantPortrait(
    { telegramMessageId: 'id-1', buffer: Buffer.from('bytes'), mimeType: 'image/jpeg' },
    { config: null, getBucket: () => { throw new Error('must never be called when config is null'); } },
  );
  assert.equal(result, null);
});

test('uploadApplicantPortrait uploads the buffer to the distinct portrait object path and returns it', async () => {
  const { deps, savedCalls } = buildFakeDeps();
  const result = await uploadApplicantPortrait(
    { telegramMessageId: '11111111-1111-1111-1111-111111111111', buffer: Buffer.from('fake-cropped-portrait-bytes'), mimeType: 'image/jpeg' },
    deps,
  );

  assert.equal(result, 'visa-photos/11111111-1111-1111-1111-111111111111-portrait.jpg');
  assert.equal(savedCalls.length, 1);
  assert.equal(savedCalls[0]?.objectPath, 'visa-photos/11111111-1111-1111-1111-111111111111-portrait.jpg');
  assert.equal(savedCalls[0]?.buffer.toString(), 'fake-cropped-portrait-bytes');
  assert.equal(savedCalls[0]?.contentType, 'image/jpeg');
});

test('uploadApplicantPortrait propagates a real storage failure to its caller (performPassportOcr.ts is responsible for catching it)', async () => {
  const deps: UploadApplicantPhotoDependencies = {
    config: CONFIG,
    getBucket: () =>
      ({
        file: () => ({
          save: async () => {
            throw new Error('GCS upload failed: service unavailable');
          },
        }),
      }) as unknown as ReturnType<UploadApplicantPhotoDependencies['getBucket']>,
  };

  await assert.rejects(
    () => uploadApplicantPortrait({ telegramMessageId: 'id-1', buffer: Buffer.from('bytes'), mimeType: 'image/jpeg' }, deps),
    /GCS upload failed/,
  );
});
