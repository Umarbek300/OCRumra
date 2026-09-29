import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  provisionSpreadsheetViaAppsScript,
  resolveAppsScriptProvisioningConfig,
  type ProvisionSpreadsheetDependencies,
} from '../src/sheets/appsScriptProvisioning.js';

const REQUEST = { title: 'Test Group — 2026-01-01', folderId: 'folder-abc', requestId: 'group-1' };

const CONFIG = { webAppUrl: 'https://script.google.com/macros/s/FAKE/exec', sharedSecret: 'super-secret-token' };

function fakeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function buildDeps(overrides: Partial<ProvisionSpreadsheetDependencies> = {}): {
  deps: ProvisionSpreadsheetDependencies;
  calls: { fetch: number; lastUrl: string | null; lastBody: unknown };
} {
  const calls: { fetch: number; lastUrl: string | null; lastBody: unknown } = { fetch: 0, lastUrl: null, lastBody: null };
  const deps: ProvisionSpreadsheetDependencies = {
    fetchImpl: (async (url: string, init?: RequestInit) => {
      calls.fetch += 1;
      calls.lastUrl = url;
      calls.lastBody = init?.body ? JSON.parse(init.body as string) : null;
      return fakeResponse(200, { ok: true, spreadsheetId: 'sheet-xyz', requestId: REQUEST.requestId });
    }) as unknown as typeof fetch,
    getConfig: () => CONFIG,
    getTimeoutMs: () => 30_000,
    ...overrides,
  };
  return { deps, calls };
}

test('resolveAppsScriptProvisioningConfig throws a clear error when APPS_SCRIPT_WEB_APP_URL is missing', () => {
  assert.throws(() => resolveAppsScriptProvisioningConfig({}), /APPS_SCRIPT_WEB_APP_URL is not configured/);
});

test('resolveAppsScriptProvisioningConfig throws a clear error when APPS_SCRIPT_SHARED_SECRET is missing', () => {
  assert.throws(
    () => resolveAppsScriptProvisioningConfig({ APPS_SCRIPT_WEB_APP_URL: 'https://example.com' }),
    /APPS_SCRIPT_SHARED_SECRET is not configured/,
  );
});

test('resolveAppsScriptProvisioningConfig returns both values when configured', () => {
  const config = resolveAppsScriptProvisioningConfig({
    APPS_SCRIPT_WEB_APP_URL: 'https://example.com/exec',
    APPS_SCRIPT_SHARED_SECRET: 'abc',
  });
  assert.deepEqual(config, { webAppUrl: 'https://example.com/exec', sharedSecret: 'abc' });
});

test('provisionSpreadsheetViaAppsScript returns the spreadsheetId on a successful, matching response', async () => {
  const { deps } = buildDeps();
  const result = await provisionSpreadsheetViaAppsScript(REQUEST, deps);
  assert.deepEqual(result, { spreadsheetId: 'sheet-xyz' });
});

test('provisionSpreadsheetViaAppsScript sends the token in the JSON body, Content-Type application/json, and no other transport for the secret', async () => {
  const { deps, calls } = buildDeps();
  await provisionSpreadsheetViaAppsScript(REQUEST, deps);

  assert.equal(calls.lastUrl, CONFIG.webAppUrl, 'the secret must never be appended to the URL as a query parameter');
  assert.deepEqual(calls.lastBody, {
    token: CONFIG.sharedSecret,
    title: REQUEST.title,
    folderId: REQUEST.folderId,
    requestId: REQUEST.requestId,
  });
});

test('provisionSpreadsheetViaAppsScript passes the configured timeout via AbortSignal', async () => {
  let sawSignal = false;
  const { deps } = buildDeps({
    fetchImpl: (async (_url: string, init?: RequestInit) => {
      sawSignal = init?.signal instanceof AbortSignal;
      return fakeResponse(200, { ok: true, spreadsheetId: 'sheet-xyz', requestId: REQUEST.requestId });
    }) as unknown as typeof fetch,
  });
  await provisionSpreadsheetViaAppsScript(REQUEST, deps);
  assert.equal(sawSignal, true);
});

test('provisionSpreadsheetViaAppsScript throws on a non-2xx HTTP status', async () => {
  const { deps } = buildDeps({
    fetchImpl: (async () => fakeResponse(500, { ok: false, error: 'boom' })) as unknown as typeof fetch,
  });
  await assert.rejects(() => provisionSpreadsheetViaAppsScript(REQUEST, deps), /HTTP 500/);
});

test('provisionSpreadsheetViaAppsScript throws with the reported error when the response body says ok:false', async () => {
  const { deps } = buildDeps({
    fetchImpl: (async () => fakeResponse(200, { ok: false, error: 'unauthorized', requestId: REQUEST.requestId })) as unknown as typeof fetch,
  });
  await assert.rejects(() => provisionSpreadsheetViaAppsScript(REQUEST, deps), /unauthorized/);
});

test('provisionSpreadsheetViaAppsScript throws a clear error on a malformed (non-JSON) response body', async () => {
  const { deps } = buildDeps({
    fetchImpl: (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token');
        },
      }) as unknown as Response) as unknown as typeof fetch,
  });
  await assert.rejects(() => provisionSpreadsheetViaAppsScript(REQUEST, deps), /not valid JSON/);
});

test('provisionSpreadsheetViaAppsScript throws a clear error when the response is JSON but not an object', async () => {
  const { deps } = buildDeps({ fetchImpl: (async () => fakeResponse(200, 'just a string')) as unknown as typeof fetch });
  await assert.rejects(() => provisionSpreadsheetViaAppsScript(REQUEST, deps), /not a JSON object/);
});

test('provisionSpreadsheetViaAppsScript throws a clear error when spreadsheetId is missing', async () => {
  const { deps } = buildDeps({
    fetchImpl: (async () => fakeResponse(200, { ok: true, requestId: REQUEST.requestId })) as unknown as typeof fetch,
  });
  await assert.rejects(() => provisionSpreadsheetViaAppsScript(REQUEST, deps), /did not include a valid spreadsheetId/);
});

test('provisionSpreadsheetViaAppsScript throws a clear error when spreadsheetId is an empty string', async () => {
  const { deps } = buildDeps({
    fetchImpl: (async () => fakeResponse(200, { ok: true, spreadsheetId: '', requestId: REQUEST.requestId })) as unknown as typeof fetch,
  });
  await assert.rejects(() => provisionSpreadsheetViaAppsScript(REQUEST, deps), /did not include a valid spreadsheetId/);
});

test('provisionSpreadsheetViaAppsScript throws a clear error when the response requestId does not match the request', async () => {
  const { deps } = buildDeps({
    fetchImpl: (async () => fakeResponse(200, { ok: true, spreadsheetId: 'sheet-xyz', requestId: 'some-other-group' })) as unknown as typeof fetch,
  });
  await assert.rejects(() => provisionSpreadsheetViaAppsScript(REQUEST, deps), /requestId does not match/);
});

test('provisionSpreadsheetViaAppsScript never includes the shared secret in a thrown error, even on failure', async () => {
  const { deps } = buildDeps({
    fetchImpl: (async () => {
      throw new Error(`network exploded while calling ${CONFIG.sharedSecret}`);
    }) as unknown as typeof fetch,
  });
  await assert.rejects(() => provisionSpreadsheetViaAppsScript(REQUEST, deps), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(!error.message.includes(CONFIG.sharedSecret), `error message leaked the secret: ${error.message}`);
    return true;
  });
});
