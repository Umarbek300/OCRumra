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
  calls: { findExisting: number; download: number; extract: number; save: number; enqueueSheetSync: number };
} {
  const calls = { findExisting: 0, download: 0, extract: 0, save: 0, enqueueSheetSync: 0 };
  const deps: PerformPassportOcrDependencies = {
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
    saveResult: async (input) => {
      calls.save += 1;
      return { id: 'result-id', createdAt: 'now', updatedAt: 'now', ...input } as PassportOcrResultRecord;
    },
    enqueueSheetSync: async (telegramMessageId) => {
      calls.enqueueSheetSync += 1;
      return { id: 'sheet-sync-id', telegramMessageId } as never;
    },
    ...overrides,
  };
  return { deps, calls };
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
