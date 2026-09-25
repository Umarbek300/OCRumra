import { existsSync } from 'node:fs';
import { google, type drive_v3, type sheets_v4 } from 'googleapis';
import { env } from '../config/env.js';

/**
 * spreadsheets: create/read/write group sheets. drive.file: move a
 * spreadsheet this service account created into a Drive folder — narrowest
 * scope that can do that, never the full `drive` scope (never needs to see
 * files it didn't create itself).
 */
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.file'];

export interface SheetsAuthConfig {
  keyFilePath: string;
  driveFolderId: string | null;
}

export interface SheetsAuthEnvSource {
  GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY_FILE?: string;
  GOOGLE_SHEETS_DRIVE_FOLDER_ID?: string;
}

/**
 * Resolves and validates config only — never touches the network, never
 * constructs a googleapis client. Kept pure and injectable (source, and a
 * fileExists check) so it is fully unit-testable without a real
 * filesystem or real env. Fails clearly, but NEVER logs or includes the
 * key file's contents — only the configured path, which is a filesystem
 * location, not a secret (same convention as GOOGLE_APPLICATION_CREDENTIALS
 * for the Vision provider elsewhere in this codebase).
 */
export function resolveSheetsAuthConfig(
  source: SheetsAuthEnvSource = env,
  fileExists: (path: string) => boolean = existsSync,
): SheetsAuthConfig {
  const keyFilePath = source.GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY_FILE;
  if (!keyFilePath) {
    throw new Error(
      'GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY_FILE is not configured — Sheets sync cannot authenticate. ' +
        'Set it to the path of a Google service-account JSON key file.',
    );
  }
  if (!fileExists(keyFilePath)) {
    throw new Error(`GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY_FILE is configured but the file does not exist: ${keyFilePath}`);
  }
  return { keyFilePath, driveFolderId: source.GOOGLE_SHEETS_DRIVE_FOLDER_ID ?? null };
}

export interface SheetsClients {
  sheets: sheets_v4.Sheets;
  drive: drive_v3.Drive;
}

let cachedClients: SheetsClients | null = null;

/**
 * Lazily builds (and caches) the real googleapis clients from the
 * key-file path resolveSheetsAuthConfig() validated. Never logs the
 * client, the auth object, or anything read from the key file — only ever
 * throws the same path-only error resolveSheetsAuthConfig produces.
 */
export function getSheetsClients(): SheetsClients {
  if (cachedClients) return cachedClients;

  const { keyFilePath } = resolveSheetsAuthConfig();
  const auth = new google.auth.GoogleAuth({ keyFile: keyFilePath, scopes: SCOPES });
  cachedClients = {
    sheets: google.sheets({ version: 'v4', auth }),
    drive: google.drive({ version: 'v3', auth }),
  };
  return cachedClients;
}

export function getConfiguredDriveFolderId(): string | null {
  return resolveSheetsAuthConfig().driveFolderId;
}

export interface SheetsApiTimeoutEnvSource {
  GOOGLE_SHEETS_API_TIMEOUT_MS?: number;
}

/** Matches env.schema.ts's own zod default literal — kept in sync manually, same as every other bare default value in this codebase (e.g. ANTHROPIC_MODEL's). Only reached when the injected source omits the field (env.schema.ts's zod default already guarantees the real env singleton never does). */
const DEFAULT_API_TIMEOUT_MS = 30_000;

/**
 * Per-request timeout (ms) applied to every Sheets/Drive API call this
 * pipeline makes — see ensureGroupSheet.ts and upsertRowInSheet.ts, which
 * both pass `{ timeout: getConfiguredApiTimeoutMs() }` as the gaxios
 * request options on every call. Injectable source (same pattern as
 * resolveSheetsAuthConfig above), so this is testable without depending on
 * the real parsed env singleton.
 */
export function getConfiguredApiTimeoutMs(source: SheetsApiTimeoutEnvSource = env): number {
  return source.GOOGLE_SHEETS_API_TIMEOUT_MS ?? DEFAULT_API_TIMEOUT_MS;
}

/** Test-only: clears the cached client singleton so tests can exercise getSheetsClients() repeatedly under different config. */
export function __resetSheetsClientsCacheForTests(): void {
  cachedClients = null;
}
