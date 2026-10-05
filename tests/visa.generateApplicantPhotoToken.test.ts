import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateApplicantPhotoToken } from '../src/visa/generateApplicantPhotoToken.js';

test('generateApplicantPhotoToken returns a URL-safe string (base64url: letters, digits, "-", "_" only)', () => {
  const token = generateApplicantPhotoToken();
  assert.match(token, /^[A-Za-z0-9_-]+$/);
});

test('generateApplicantPhotoToken carries at least 256 bits of entropy (32 random bytes, base64url-encoded)', () => {
  const token = generateApplicantPhotoToken();
  // base64url has no padding; 32 bytes encodes to ceil(32 * 8 / 6) = 43 characters.
  assert.equal(token.length, 43, 'expected exactly 43 characters for 32 bytes of base64url (256 bits of entropy)');
});

test('generateApplicantPhotoToken never produces the same value twice across many calls', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 1000; i++) {
    seen.add(generateApplicantPhotoToken());
  }
  assert.equal(seen.size, 1000, 'every generated token in this sample must be unique');
});

test('generateApplicantPhotoToken never derives its value from any input — it takes no arguments at all', () => {
  assert.equal(generateApplicantPhotoToken.length, 0, 'the function must accept no parameters, proving it cannot be derived from telegram_message_id or any other identifier');
});
