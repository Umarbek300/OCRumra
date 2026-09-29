import { env } from '../config/env.js';
import { getConfiguredApiTimeoutMs } from './sheetsAuth.js';

const MAX_ERROR_MESSAGE_LENGTH = 300;

export interface AppsScriptProvisioningEnvSource {
  APPS_SCRIPT_WEB_APP_URL?: string;
  APPS_SCRIPT_SHARED_SECRET?: string;
}

export interface AppsScriptProvisioningConfig {
  webAppUrl: string;
  sharedSecret: string;
}

/**
 * Resolves and validates config only — never touches the network. Same
 * pattern and error-message style as sheetsAuth.ts's own
 * resolveSheetsAuthConfig: fails clearly, but NEVER logs or includes the
 * secret's own value — only ever says which env var is missing.
 */
export function resolveAppsScriptProvisioningConfig(
  source: AppsScriptProvisioningEnvSource = env,
): AppsScriptProvisioningConfig {
  const webAppUrl = source.APPS_SCRIPT_WEB_APP_URL;
  if (!webAppUrl) {
    throw new Error(
      'APPS_SCRIPT_WEB_APP_URL is not configured — spreadsheet provisioning cannot run. ' +
        'Set it to the deployed Apps Script Web App URL.',
    );
  }
  const sharedSecret = source.APPS_SCRIPT_SHARED_SECRET;
  if (!sharedSecret) {
    throw new Error(
      'APPS_SCRIPT_SHARED_SECRET is not configured — spreadsheet provisioning cannot run. ' +
        "Set it to the same value configured in the Apps Script project's Script Properties.",
    );
  }
  return { webAppUrl, sharedSecret };
}

export interface AppsScriptProvisionRequest {
  /** Tour-group metadata only (see buildSpreadsheetTitle) — never passport/OCR data. */
  title: string;
  folderId: string;
  /** The group's own id — Apps Script uses this as its idempotency key (requestId -> spreadsheetId). */
  requestId: string;
}

export interface AppsScriptProvisionResult {
  spreadsheetId: string;
}

export interface ProvisionSpreadsheetDependencies {
  fetchImpl: typeof fetch;
  getConfig: () => AppsScriptProvisioningConfig;
  getTimeoutMs: () => number;
}

const defaultDependencies: ProvisionSpreadsheetDependencies = {
  fetchImpl: fetch,
  getConfig: resolveAppsScriptProvisioningConfig,
  getTimeoutMs: getConfiguredApiTimeoutMs,
};

/**
 * secretToRedact is optional only so this can be used before config is
 * even resolved (there is no secret to redact yet in that case) — every
 * call site once the secret IS known passes it, so it can never leak into
 * a thrown error even if some underlying error message happened to echo
 * back part of the request (fetch's own network/timeout errors never do
 * this in practice, but this is defense in depth, not reliance on that).
 */
function sanitizeErrorMessage(error: unknown, secretToRedact?: string): string {
  const message = error instanceof Error ? error.message : 'unknown error';
  const redacted = secretToRedact && secretToRedact.length > 0 ? message.split(secretToRedact).join('[redacted]') : message;
  return redacted.slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

/**
 * Calls the Apps Script Web App to provision (or, idempotently, look up)
 * a brand-new Google Spreadsheet under a real Google account's own Drive
 * quota — a plain service account (no domain-wide delegation) has none,
 * so it cannot create files on its own; see ensureGroupSheet.ts's own doc
 * comment for the full "why".
 *
 * Sends and receives ONLY {token, title, folderId, requestId} /
 * {ok, spreadsheetId, requestId} — structurally never carries passport/OCR
 * data. The shared secret travels in the JSON body (never a header — Apps
 * Script's doPost cannot read custom headers — and never a URL query
 * parameter, to keep it out of any URL-based logging) and is never
 * included in any error this function throws, logs, or otherwise surfaces.
 *
 * Reuses the same per-request timeout every other Sheets/Drive call in
 * this pipeline uses (GOOGLE_SHEETS_API_TIMEOUT_MS via
 * getConfiguredApiTimeoutMs()) via the native AbortSignal.timeout(), same
 * mechanism gaxios itself uses under the hood elsewhere in this codebase —
 * so a hung Apps Script call can never block the sheets sync worker's
 * current job indefinitely.
 */
export async function provisionSpreadsheetViaAppsScript(
  request: AppsScriptProvisionRequest,
  deps: ProvisionSpreadsheetDependencies = defaultDependencies,
): Promise<AppsScriptProvisionResult> {
  const { webAppUrl, sharedSecret } = deps.getConfig();

  let response: Response;
  try {
    response = await deps.fetchImpl(webAppUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: sharedSecret,
        title: request.title,
        folderId: request.folderId,
        requestId: request.requestId,
      }),
      signal: AbortSignal.timeout(deps.getTimeoutMs()),
    });
  } catch (error) {
    // A network/timeout error from fetch itself never includes the request
    // body, so redacting the secret here is defense in depth, not the only
    // guard against it ever appearing in a thrown error.
    throw new Error(`Apps Script provisioning request failed: ${sanitizeErrorMessage(error, sharedSecret)}`);
  }

  if (!response.ok) {
    throw new Error(`Apps Script provisioning request failed: HTTP ${response.status}`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new Error(`Apps Script provisioning response was not valid JSON: ${sanitizeErrorMessage(error, sharedSecret)}`);
  }

  if (!body || typeof body !== 'object') {
    throw new Error('Apps Script provisioning response was not a JSON object');
  }
  const parsed = body as Record<string, unknown>;

  if (parsed.ok !== true) {
    const reportedError = typeof parsed.error === 'string' ? parsed.error.slice(0, MAX_ERROR_MESSAGE_LENGTH) : 'unknown error';
    throw new Error(`Apps Script provisioning reported failure: ${reportedError}`);
  }

  if (parsed.requestId !== request.requestId) {
    throw new Error('Apps Script provisioning response requestId does not match the request');
  }

  if (typeof parsed.spreadsheetId !== 'string' || parsed.spreadsheetId.length === 0) {
    throw new Error('Apps Script provisioning response did not include a valid spreadsheetId');
  }

  return { spreadsheetId: parsed.spreadsheetId };
}

export interface AppsScriptEnsureTabRequest {
  /** The one, fixed master spreadsheet's id — passed explicitly by the caller, never read from env by this function itself. */
  masterSpreadsheetId: string;
  /** Passed through to Apps Script exactly as given — never trimmed, cased, or otherwise normalized here. */
  tabTitle: string;
  /** Apps Script uses this as its idempotency key (requestId -> tab mapping), same role requestId plays in provisionSpreadsheetViaAppsScript. */
  requestId: string;
}

export interface AppsScriptEnsureTabResult {
  /** Always the same value as the request's masterSpreadsheetId on success — the one fixed master file. */
  spreadsheetId: string;
  /** The tab's persistent gid — the ONLY stable identifier for it; never derive a range from `title` without re-resolving it live first (see sheetLayout.ts's withSheetTitle doc comment). */
  sheetId: number;
  /** The tab's current title. Never cache/persist this as an addressing key — a human can rename a tab at any time. */
  title: string;
  /** true if this call just created the tab, false if an existing, verified-owned tab was found and reused (idempotent repeat call). */
  created: boolean;
}

/**
 * Calls the Apps Script Web App's `ensureTab` action to idempotently create
 * (or look up) one Telegram group's tab inside the single, shared master
 * Google Spreadsheet — the target "one master file, one tab per group"
 * architecture, as opposed to provisionSpreadsheetViaAppsScript's legacy
 * "one dedicated file per group" contract, which this function does not
 * touch, replace, or share any request/response shape with.
 *
 * Sends {token, action: "ensureTab", masterSpreadsheetId, tabTitle,
 * requestId} / receives {ok, spreadsheetId, sheetId, title, created,
 * requestId} — same secret-transport, timeout, and error-sanitization
 * rules as provisionSpreadsheetViaAppsScript (see that function's own doc
 * comment for the full rationale, which applies identically here).
 *
 * Not yet called from any production code path in this stage — this is
 * only the API client function itself.
 */
export async function provisionTabViaAppsScript(
  request: AppsScriptEnsureTabRequest,
  deps: ProvisionSpreadsheetDependencies = defaultDependencies,
): Promise<AppsScriptEnsureTabResult> {
  const { webAppUrl, sharedSecret } = deps.getConfig();

  let response: Response;
  try {
    response = await deps.fetchImpl(webAppUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: sharedSecret,
        action: 'ensureTab',
        masterSpreadsheetId: request.masterSpreadsheetId,
        tabTitle: request.tabTitle,
        requestId: request.requestId,
      }),
      signal: AbortSignal.timeout(deps.getTimeoutMs()),
    });
  } catch (error) {
    throw new Error(`Apps Script ensureTab request failed: ${sanitizeErrorMessage(error, sharedSecret)}`);
  }

  if (!response.ok) {
    throw new Error(`Apps Script ensureTab request failed: HTTP ${response.status}`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new Error(`Apps Script ensureTab response was not valid JSON: ${sanitizeErrorMessage(error, sharedSecret)}`);
  }

  if (!body || typeof body !== 'object') {
    throw new Error('Apps Script ensureTab response was not a JSON object');
  }
  const parsed = body as Record<string, unknown>;

  if (parsed.ok !== true) {
    const reportedError = typeof parsed.error === 'string' ? parsed.error.slice(0, MAX_ERROR_MESSAGE_LENGTH) : 'unknown error';
    throw new Error(`Apps Script ensureTab reported failure: ${reportedError}`);
  }

  if (parsed.requestId !== request.requestId) {
    throw new Error('Apps Script ensureTab response requestId does not match the request');
  }

  if (typeof parsed.spreadsheetId !== 'string' || parsed.spreadsheetId.length === 0) {
    throw new Error('Apps Script ensureTab response did not include a valid spreadsheetId');
  }
  if (typeof parsed.sheetId !== 'number' || !Number.isFinite(parsed.sheetId)) {
    throw new Error('Apps Script ensureTab response did not include a valid sheetId');
  }
  if (typeof parsed.title !== 'string' || parsed.title.length === 0) {
    throw new Error('Apps Script ensureTab response did not include a valid title');
  }
  if (typeof parsed.created !== 'boolean') {
    throw new Error('Apps Script ensureTab response did not include a valid created flag');
  }

  return {
    spreadsheetId: parsed.spreadsheetId,
    sheetId: parsed.sheetId,
    title: parsed.title,
    created: parsed.created,
  };
}
