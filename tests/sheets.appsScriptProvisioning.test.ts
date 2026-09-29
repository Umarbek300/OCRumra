import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  provisionSpreadsheetViaAppsScript,
  provisionTabViaAppsScript,
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

// --- provisionTabViaAppsScript (new, parallel "ensureTab" client — not yet called from any production path) ---

const TAB_REQUEST = { masterSpreadsheetId: 'master-sheet-id', tabTitle: 'Group A — 2026-01-01', requestId: 'group-1' };

function buildTabDeps(overrides: Partial<ProvisionSpreadsheetDependencies> = {}): {
  deps: ProvisionSpreadsheetDependencies;
  calls: { fetch: number; lastUrl: string | null; lastBody: unknown; lastHeaders: Record<string, string> | undefined };
} {
  const calls: { fetch: number; lastUrl: string | null; lastBody: unknown; lastHeaders: Record<string, string> | undefined } = {
    fetch: 0,
    lastUrl: null,
    lastBody: null,
    lastHeaders: undefined,
  };
  const deps: ProvisionSpreadsheetDependencies = {
    fetchImpl: (async (url: string, init?: RequestInit) => {
      calls.fetch += 1;
      calls.lastUrl = url;
      calls.lastBody = init?.body ? JSON.parse(init.body as string) : null;
      calls.lastHeaders = init?.headers as Record<string, string> | undefined;
      return fakeResponse(200, {
        ok: true,
        spreadsheetId: TAB_REQUEST.masterSpreadsheetId,
        sheetId: 123456789,
        title: TAB_REQUEST.tabTitle,
        created: true,
        requestId: TAB_REQUEST.requestId,
      });
    }) as unknown as typeof fetch,
    getConfig: () => CONFIG,
    getTimeoutMs: () => 30_000,
    ...overrides,
  };
  return { deps, calls };
}

// 1. correct POST body
test('provisionTabViaAppsScript sends the correct ensureTab request body', async () => {
  const { deps, calls } = buildTabDeps();
  await provisionTabViaAppsScript(TAB_REQUEST, deps);

  assert.equal(calls.lastUrl, CONFIG.webAppUrl);
  assert.deepEqual(calls.lastBody, {
    token: CONFIG.sharedSecret,
    action: 'ensureTab',
    masterSpreadsheetId: TAB_REQUEST.masterSpreadsheetId,
    tabTitle: TAB_REQUEST.tabTitle,
    requestId: TAB_REQUEST.requestId,
  });
});

// 2. correct headers/auth pattern
test('provisionTabViaAppsScript sends the token only in the JSON body (Content-Type application/json), never as a header or URL parameter', async () => {
  const { deps, calls } = buildTabDeps();
  await provisionTabViaAppsScript(TAB_REQUEST, deps);

  assert.equal(calls.lastUrl, CONFIG.webAppUrl, 'the secret must never be appended to the URL as a query parameter');
  assert.deepEqual(calls.lastHeaders, { 'Content-Type': 'application/json' });
  assert.equal((calls.lastBody as { token: string }).token, CONFIG.sharedSecret);
});

// 3. successful response
test('provisionTabViaAppsScript returns spreadsheetId/sheetId/title/created on a successful, matching response', async () => {
  const { deps } = buildTabDeps();
  const result = await provisionTabViaAppsScript(TAB_REQUEST, deps);
  assert.deepEqual(result, {
    spreadsheetId: TAB_REQUEST.masterSpreadsheetId,
    sheetId: 123456789,
    title: TAB_REQUEST.tabTitle,
    created: true,
  });
  assert.equal(typeof result.sheetId, 'number', 'sheetId must be a number, never coerced to a string');
});

// 4. created:false idempotent response
test('provisionTabViaAppsScript returns created:false on an idempotent repeat-call response', async () => {
  const { deps } = buildTabDeps({
    fetchImpl: (async () =>
      fakeResponse(200, {
        ok: true,
        spreadsheetId: TAB_REQUEST.masterSpreadsheetId,
        sheetId: 123456789,
        title: TAB_REQUEST.tabTitle,
        created: false,
        requestId: TAB_REQUEST.requestId,
      })) as unknown as typeof fetch,
  });
  const result = await provisionTabViaAppsScript(TAB_REQUEST, deps);
  assert.equal(result.created, false);
  assert.equal(result.sheetId, 123456789);
});

// 5. invalid response rejection (several distinct shapes)
test('provisionTabViaAppsScript throws when sheetId is missing', async () => {
  const { deps } = buildTabDeps({
    fetchImpl: (async () =>
      fakeResponse(200, { ok: true, spreadsheetId: TAB_REQUEST.masterSpreadsheetId, title: TAB_REQUEST.tabTitle, created: true, requestId: TAB_REQUEST.requestId })) as unknown as typeof fetch,
  });
  await assert.rejects(() => provisionTabViaAppsScript(TAB_REQUEST, deps), /did not include a valid sheetId/);
});

test('provisionTabViaAppsScript throws when sheetId is a string instead of a number', async () => {
  const { deps } = buildTabDeps({
    fetchImpl: (async () =>
      fakeResponse(200, {
        ok: true,
        spreadsheetId: TAB_REQUEST.masterSpreadsheetId,
        sheetId: '123456789',
        title: TAB_REQUEST.tabTitle,
        created: true,
        requestId: TAB_REQUEST.requestId,
      })) as unknown as typeof fetch,
  });
  await assert.rejects(() => provisionTabViaAppsScript(TAB_REQUEST, deps), /did not include a valid sheetId/);
});

test('provisionTabViaAppsScript throws when title is missing', async () => {
  const { deps } = buildTabDeps({
    fetchImpl: (async () =>
      fakeResponse(200, { ok: true, spreadsheetId: TAB_REQUEST.masterSpreadsheetId, sheetId: 1, created: true, requestId: TAB_REQUEST.requestId })) as unknown as typeof fetch,
  });
  await assert.rejects(() => provisionTabViaAppsScript(TAB_REQUEST, deps), /did not include a valid title/);
});

test('provisionTabViaAppsScript throws when created is missing/not a boolean', async () => {
  const { deps } = buildTabDeps({
    fetchImpl: (async () =>
      fakeResponse(200, { ok: true, spreadsheetId: TAB_REQUEST.masterSpreadsheetId, sheetId: 1, title: TAB_REQUEST.tabTitle, requestId: TAB_REQUEST.requestId })) as unknown as typeof fetch,
  });
  await assert.rejects(() => provisionTabViaAppsScript(TAB_REQUEST, deps), /did not include a valid created flag/);
});

test('provisionTabViaAppsScript throws when spreadsheetId is missing', async () => {
  const { deps } = buildTabDeps({
    fetchImpl: (async () =>
      fakeResponse(200, { ok: true, sheetId: 1, title: TAB_REQUEST.tabTitle, created: true, requestId: TAB_REQUEST.requestId })) as unknown as typeof fetch,
  });
  await assert.rejects(() => provisionTabViaAppsScript(TAB_REQUEST, deps), /did not include a valid spreadsheetId/);
});

test('provisionTabViaAppsScript throws with the reported error when the response body says ok:false', async () => {
  const { deps } = buildTabDeps({
    fetchImpl: (async () => fakeResponse(200, { ok: false, error: 'MASTER_SPREADSHEET_ID is not configured in Script Properties', requestId: TAB_REQUEST.requestId })) as unknown as typeof fetch,
  });
  await assert.rejects(() => provisionTabViaAppsScript(TAB_REQUEST, deps), /MASTER_SPREADSHEET_ID is not configured/);
});

test('provisionTabViaAppsScript throws when the response requestId does not match the request', async () => {
  const { deps } = buildTabDeps({
    fetchImpl: (async () =>
      fakeResponse(200, { ok: true, spreadsheetId: TAB_REQUEST.masterSpreadsheetId, sheetId: 1, title: TAB_REQUEST.tabTitle, created: true, requestId: 'some-other-group' })) as unknown as typeof fetch,
  });
  await assert.rejects(() => provisionTabViaAppsScript(TAB_REQUEST, deps), /requestId does not match/);
});

// 6. non-2xx rejection
test('provisionTabViaAppsScript throws on a non-2xx HTTP status', async () => {
  const { deps } = buildTabDeps({
    fetchImpl: (async () => fakeResponse(500, { ok: false, error: 'boom' })) as unknown as typeof fetch,
  });
  await assert.rejects(() => provisionTabViaAppsScript(TAB_REQUEST, deps), /HTTP 500/);
});

test('provisionTabViaAppsScript throws a clear error on network failure and never leaks the shared secret', async () => {
  const { deps } = buildTabDeps({
    fetchImpl: (async () => {
      throw new Error(`network exploded while calling ${CONFIG.sharedSecret}`);
    }) as unknown as typeof fetch,
  });
  await assert.rejects(() => provisionTabViaAppsScript(TAB_REQUEST, deps), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(!error.message.includes(CONFIG.sharedSecret), `error message leaked the secret: ${error.message}`);
    return true;
  });
});

test('provisionTabViaAppsScript throws a clear error on a malformed (non-JSON) response body', async () => {
  const { deps } = buildTabDeps({
    fetchImpl: (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token');
        },
      }) as unknown as Response) as unknown as typeof fetch,
  });
  await assert.rejects(() => provisionTabViaAppsScript(TAB_REQUEST, deps), /not valid JSON/);
});

test('provisionTabViaAppsScript passes tabTitle through unmodified (no trimming/normalization)', async () => {
  const untrimmedRequest = { ...TAB_REQUEST, tabTitle: '  Group With Spaces  ' };
  const { deps, calls } = buildTabDeps();
  await provisionTabViaAppsScript(untrimmedRequest, deps);
  assert.equal((calls.lastBody as { tabTitle: string }).tabTitle, '  Group With Spaces  ');
});
