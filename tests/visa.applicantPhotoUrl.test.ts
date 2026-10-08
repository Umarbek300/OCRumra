import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApplicantPhotoPublicUrl, buildApplicantPortraitPublicUrl } from '../src/visa/applicantPhotoUrl.js';

const SAMPLE_TOKEN = 'xR7k2mQpL9vN4zT8wF1yB6hJ3cD0aE5sG2uK7iM9oPw';

test('buildApplicantPhotoPublicUrl builds the durable /visa-photos/:token URL from the base URL and the dedicated token', () => {
  const url = buildApplicantPhotoPublicUrl('https://visa.mahbubtour.uz', SAMPLE_TOKEN);
  assert.equal(url, `https://visa.mahbubtour.uz/visa-photos/${SAMPLE_TOKEN}`);
});

test('buildApplicantPhotoPublicUrl strips a trailing slash from the base URL', () => {
  const url = buildApplicantPhotoPublicUrl('https://visa.mahbubtour.uz/', SAMPLE_TOKEN);
  assert.equal(url, `https://visa.mahbubtour.uz/visa-photos/${SAMPLE_TOKEN}`);
});

test('buildApplicantPhotoPublicUrl never embeds a telegram_message_id, passport number, applicant name, or any other PII — only the opaque token it is given', () => {
  const telegramMessageId = '11111111-1111-1111-1111-111111111111';
  const url = buildApplicantPhotoPublicUrl('https://visa.mahbubtour.uz', SAMPLE_TOKEN);
  assert.ok(!url.includes('passport'));
  assert.ok(!url.includes(telegramMessageId), 'the URL must never contain a telegram_message_id, even one belonging to the same applicant');
  assert.equal(url, `https://visa.mahbubtour.uz/visa-photos/${SAMPLE_TOKEN}`);
});

// --- buildApplicantPortraitPublicUrl (column V, the cropped portrait — fully independent of buildApplicantPhotoPublicUrl above) ---

test('buildApplicantPortraitPublicUrl builds the durable /visa-portraits/:token URL from the base URL and the dedicated portrait token', () => {
  const url = buildApplicantPortraitPublicUrl('https://visa.mahbubtour.uz', SAMPLE_TOKEN);
  assert.equal(url, `https://visa.mahbubtour.uz/visa-portraits/${SAMPLE_TOKEN}`);
});

test('buildApplicantPortraitPublicUrl strips a trailing slash from the base URL', () => {
  const url = buildApplicantPortraitPublicUrl('https://visa.mahbubtour.uz/', SAMPLE_TOKEN);
  assert.equal(url, `https://visa.mahbubtour.uz/visa-portraits/${SAMPLE_TOKEN}`);
});

test('buildApplicantPortraitPublicUrl never embeds a telegram_message_id, personal_photo_token, passport number, applicant name, or any other identifier — only the opaque portrait token it is given', () => {
  const telegramMessageId = '11111111-1111-1111-1111-111111111111';
  const personalPhotoToken = 'photo-token-not-the-portrait-token';
  const url = buildApplicantPortraitPublicUrl('https://visa.mahbubtour.uz', SAMPLE_TOKEN);
  assert.ok(!url.includes('passport'));
  assert.ok(!url.includes(telegramMessageId), 'the URL must never contain a telegram_message_id');
  assert.ok(!url.includes(personalPhotoToken), 'the URL must never contain the unrelated T-column personal_photo_token');
  assert.equal(url, `https://visa.mahbubtour.uz/visa-portraits/${SAMPLE_TOKEN}`);
});
