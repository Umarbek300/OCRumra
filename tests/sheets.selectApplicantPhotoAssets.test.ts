import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectApplicantPhotoAssets, type CanonicalApplicantPhotoAssets } from '../src/sheets/selectApplicantPhotoAssets.js';
import type { ApplicantPhotoAssetCandidate } from '../src/db/repositories/passportMessageLinks.repo.js';

const CANONICAL_MSG_ID = 'canonical-msg';

function canonical(overrides: Partial<CanonicalApplicantPhotoAssets> = {}): CanonicalApplicantPhotoAssets {
  return {
    telegramMessageId: CANONICAL_MSG_ID,
    personalPhotoToken: null,
    personalPortraitToken: null,
    ...overrides,
  };
}

function candidate(overrides: Partial<ApplicantPhotoAssetCandidate> = {}): ApplicantPhotoAssetCandidate {
  return {
    telegramMessageId: 'duplicate-msg',
    messageTimestamp: '2026-01-01T00:00:00.000Z',
    personalPhotoToken: null,
    personalPortraitToken: null,
    ...overrides,
  };
}

test('selectApplicantPhotoAssets uses the canonical message\'s own tokens when it has both — no fallback, identical to pre-fallback behavior', () => {
  const result = selectApplicantPhotoAssets(
    canonical({ personalPhotoToken: 'canonical-photo', personalPortraitToken: 'canonical-portrait' }),
    [candidate({ telegramMessageId: 'other-msg', personalPhotoToken: 'duplicate-photo', personalPortraitToken: 'duplicate-portrait' })],
  );

  assert.deepEqual(result, { photoToken: 'canonical-photo', portraitToken: 'canonical-portrait' });
});

test('selectApplicantPhotoAssets falls back to a duplicate\'s photo token when the canonical has none', () => {
  const result = selectApplicantPhotoAssets(
    canonical({ personalPhotoToken: null }),
    [candidate({ telegramMessageId: 'dup-1', personalPhotoToken: 'dup-photo' })],
  );

  assert.equal(result.photoToken, 'dup-photo');
});

test('selectApplicantPhotoAssets picks the MOST RECENTLY SENT duplicate (by messageTimestamp) when multiple candidates have a photo token', () => {
  const result = selectApplicantPhotoAssets(canonical(), [
    candidate({ telegramMessageId: 'dup-older', messageTimestamp: '2026-01-01T00:00:00.000Z', personalPhotoToken: 'older-photo' }),
    candidate({ telegramMessageId: 'dup-newest', messageTimestamp: '2026-01-03T00:00:00.000Z', personalPhotoToken: 'newest-photo' }),
    candidate({ telegramMessageId: 'dup-middle', messageTimestamp: '2026-01-02T00:00:00.000Z', personalPhotoToken: 'middle-photo' }),
  ]);

  assert.equal(result.photoToken, 'newest-photo');
});

test('selectApplicantPhotoAssets resolves photo and portrait completely independently — one from canonical, the other from a different duplicate', () => {
  const result = selectApplicantPhotoAssets(
    canonical({ personalPhotoToken: 'canonical-photo', personalPortraitToken: null }),
    [
      candidate({ telegramMessageId: 'dup-no-photo-has-portrait', personalPhotoToken: null, personalPortraitToken: 'dup-portrait' }),
      candidate({ telegramMessageId: 'dup-has-photo-no-portrait', personalPhotoToken: 'dup-photo-unused', personalPortraitToken: null }),
    ],
  );

  assert.deepEqual(result, { photoToken: 'canonical-photo', portraitToken: 'dup-portrait' });
});

test('selectApplicantPhotoAssets returns null for an asset type when neither the canonical nor any duplicate has one', () => {
  const result = selectApplicantPhotoAssets(canonical(), [
    candidate({ telegramMessageId: 'dup-1', personalPhotoToken: null, personalPortraitToken: null }),
  ]);

  assert.deepEqual(result, { photoToken: null, portraitToken: null });
});

test('selectApplicantPhotoAssets returns null when there are no candidates at all (e.g. a message with no passport_message_links row)', () => {
  const result = selectApplicantPhotoAssets(canonical(), []);

  assert.deepEqual(result, { photoToken: null, portraitToken: null });
});

test('selectApplicantPhotoAssets never selects the canonical\'s own entry as a "fallback" candidate even if it is present in the candidates array', () => {
  // findApplicantPhotoAssetCandidates includes the canonical's own active
  // link too (role IN ('canonical','duplicate')) — this must never be
  // double-counted as its own fallback once its own token is already known
  // to be null via the `canonical` argument.
  const result = selectApplicantPhotoAssets(canonical({ personalPhotoToken: null }), [
    candidate({ telegramMessageId: CANONICAL_MSG_ID, personalPhotoToken: 'should-never-be-picked-again', messageTimestamp: '2026-01-05T00:00:00.000Z' }),
    candidate({ telegramMessageId: 'dup-1', personalPhotoToken: 'the-real-fallback', messageTimestamp: '2026-01-01T00:00:00.000Z' }),
  ]);

  assert.equal(result.photoToken, 'the-real-fallback');
});

test('selectApplicantPhotoAssets never mutates or reorders the identity/passport fields — it only ever returns token values', () => {
  const result = selectApplicantPhotoAssets(canonical({ personalPhotoToken: 'p', personalPortraitToken: 'v' }), []);

  assert.deepEqual(Object.keys(result).sort(), ['photoToken', 'portraitToken']);
});
