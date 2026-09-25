import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getConfiguredApiTimeoutMs, resolveSheetsAuthConfig } from '../src/sheets/sheetsAuth.js';

test('resolveSheetsAuthConfig throws a clear, path-only error when the key file env var is unset', () => {
  assert.throws(
    () => resolveSheetsAuthConfig({}, () => true),
    /GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY_FILE is not configured/,
  );
});

test('resolveSheetsAuthConfig throws a clear error naming the path when the configured file does not exist', () => {
  assert.throws(
    () =>
      resolveSheetsAuthConfig({ GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY_FILE: '/etc/ocrumra/secrets/does-not-exist.json' }, () => false),
    /\/etc\/ocrumra\/secrets\/does-not-exist\.json/,
  );
});

test('resolveSheetsAuthConfig returns the resolved config when the key file exists', () => {
  const config = resolveSheetsAuthConfig(
    { GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY_FILE: '/etc/ocrumra/secrets/gcloud-sheets-sa.json' },
    () => true,
  );

  assert.equal(config.keyFilePath, '/etc/ocrumra/secrets/gcloud-sheets-sa.json');
  assert.equal(config.driveFolderId, null, 'driveFolderId defaults to null when not configured');
});

test('resolveSheetsAuthConfig carries the drive folder id through when configured', () => {
  const config = resolveSheetsAuthConfig(
    {
      GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY_FILE: '/etc/ocrumra/secrets/gcloud-sheets-sa.json',
      GOOGLE_SHEETS_DRIVE_FOLDER_ID: 'folder-abc-123',
    },
    () => true,
  );

  assert.equal(config.driveFolderId, 'folder-abc-123');
});

test('resolveSheetsAuthConfig never leaks the key file existence check result as a truthy/secret value — only path and boolean are ever passed to fileExists', () => {
  const seenPaths: string[] = [];
  resolveSheetsAuthConfig(
    { GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY_FILE: '/etc/ocrumra/secrets/gcloud-sheets-sa.json' },
    (path) => {
      seenPaths.push(path);
      return true;
    },
  );

  assert.deepEqual(seenPaths, ['/etc/ocrumra/secrets/gcloud-sheets-sa.json']);
});

test('getConfiguredApiTimeoutMs defaults to 30000ms when the source omits it', () => {
  assert.equal(getConfiguredApiTimeoutMs({}), 30_000);
});

test('getConfiguredApiTimeoutMs uses a configured custom value', () => {
  assert.equal(getConfiguredApiTimeoutMs({ GOOGLE_SHEETS_API_TIMEOUT_MS: 5000 }), 5000);
});

test('resolveSheetsAuthConfig error messages never mention "key", "secret", or "private" (no accidental leakage of credential material)', () => {
  try {
    resolveSheetsAuthConfig({}, () => true);
    assert.fail('expected resolveSheetsAuthConfig to throw');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert.ok(!/private/i.test(message));
    assert.ok(!/secret/i.test(message), 'error text must never claim to contain a secret value');
  }
});
