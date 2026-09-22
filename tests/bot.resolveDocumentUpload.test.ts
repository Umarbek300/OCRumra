import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ACCEPTED_DOCUMENT_MIME_TYPES,
  MAX_DOCUMENT_SIZE_BYTES,
  evaluateDocumentUpload,
} from '../src/bot/resolveDocumentUpload.js';

test('MAX_DOCUMENT_SIZE_BYTES matches Telegram Bot API\'s own getFile hard cap (20MB), not an invented number', () => {
  assert.equal(MAX_DOCUMENT_SIZE_BYTES, 20 * 1024 * 1024);
});

test('ACCEPTED_DOCUMENT_MIME_TYPES is a small, fixed, deduplicated image-type list', () => {
  assert.ok(Array.isArray(ACCEPTED_DOCUMENT_MIME_TYPES));
  assert.ok(ACCEPTED_DOCUMENT_MIME_TYPES.length > 0 && ACCEPTED_DOCUMENT_MIME_TYPES.length <= 6);
  assert.equal(new Set(ACCEPTED_DOCUMENT_MIME_TYPES).size, ACCEPTED_DOCUMENT_MIME_TYPES.length);
  for (const mimeType of ACCEPTED_DOCUMENT_MIME_TYPES) {
    assert.ok(mimeType.startsWith('image/'), `${mimeType} must be an image mime type`);
  }
});

test('accepts a JPEG document within the size cap', () => {
  const decision = evaluateDocumentUpload({ mimeType: 'image/jpeg', fileSize: 5 * 1024 * 1024 });
  assert.deepEqual(decision, { accepted: true });
});

test('accepts a PNG and a WebP document within the size cap', () => {
  assert.deepEqual(evaluateDocumentUpload({ mimeType: 'image/png', fileSize: 1000 }), { accepted: true });
  assert.deepEqual(evaluateDocumentUpload({ mimeType: 'image/webp', fileSize: 1000 }), { accepted: true });
});

test('accepts a document exactly at the size cap boundary', () => {
  const decision = evaluateDocumentUpload({ mimeType: 'image/jpeg', fileSize: MAX_DOCUMENT_SIZE_BYTES });
  assert.deepEqual(decision, { accepted: true });
});

test('rejects a document over the size cap', () => {
  const decision = evaluateDocumentUpload({ mimeType: 'image/jpeg', fileSize: MAX_DOCUMENT_SIZE_BYTES + 1 });
  assert.deepEqual(decision, { accepted: false, reason: 'too-large' });
});

test('rejects an unsupported mime type (e.g. a PDF sent as a document)', () => {
  const decision = evaluateDocumentUpload({ mimeType: 'application/pdf', fileSize: 1000 });
  assert.deepEqual(decision, { accepted: false, reason: 'unsupported-mime-type' });
});

test('mime type is advisory only: a missing mime type is never rejected on that basis alone', () => {
  const decision = evaluateDocumentUpload({ fileSize: 1000 });
  assert.deepEqual(decision, { accepted: true });
});

test('a missing file size is never rejected on that basis alone (cannot check what is not reported)', () => {
  const decision = evaluateDocumentUpload({ mimeType: 'image/jpeg' });
  assert.deepEqual(decision, { accepted: true });
});

test('both a missing mime type and a missing file size together still accept (nothing to check)', () => {
  assert.deepEqual(evaluateDocumentUpload({}), { accepted: true });
});
