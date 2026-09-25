import { Api, GrammyError, HttpError } from 'grammy';
import { env } from '../config/env.js';

let telegramFileApi: Api | null = null;

function getTelegramFileApi(): Api {
  if (!telegramFileApi) {
    telegramFileApi = new Api(env.TELEGRAM_BOT_TOKEN);
  }
  return telegramFileApi;
}

const EXTENSION_MIME_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
};

function inferMimeType(filePath: string): string {
  const extension = filePath.split('.').pop()?.toLowerCase() ?? '';
  return EXTENSION_MIME_TYPES[extension] ?? 'image/jpeg';
}

export interface DownloadedTelegramPhoto {
  buffer: Buffer;
  mimeType: string;
}

export interface DownloadTelegramPhotoOptions {
  /** Injectable for tests — defaults to a lazily-created grammY Api client using TELEGRAM_BOT_TOKEN. */
  api?: Pick<Api, 'getFile'>;
  /** Injectable for tests — defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests, to skip real backoff delays — defaults to a real setTimeout-based sleep. */
  sleepImpl?: (ms: number) => Promise<void>;
}

const MAX_ATTEMPTS = 3;
/** Delay before retrying attempt 2 and attempt 3, respectively — approx. 1s -> 2s backoff. */
const RETRY_BACKOFF_MS = [1000, 2000] as const;
const FETCH_TIMEOUT_MS = 20_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry-worthy for api.getFile(): a network-level failure (HttpError —
 * grammY couldn't even reach/parse a response) or a Telegram API-level
 * rate-limit/server error (GrammyError with error_code 429 or >=500).
 * Never retries a permanent 4xx (bad file id, unauthorized, etc.) — those
 * won't succeed on retry, only waste time before the same, final failure.
 */
function isRetryableGetFileError(error: unknown): boolean {
  if (error instanceof HttpError) return true;
  if (error instanceof GrammyError) return error.error_code === 429 || error.error_code >= 500;
  return false;
}

/** Same retry-worthiness rule as isRetryableGetFileError, over a raw HTTP status code. */
function isRetryableHttpStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Up to MAX_ATTEMPTS, retrying only retry-worthy failures (see
 * isRetryableGetFileError) with the shared backoff schedule. A permanent
 * failure is rethrown immediately on its first occurrence, unchanged from
 * the pre-retry behavior. Never logs the file id, token, or any response
 * content — only the caller's existing sanitized error wrapping applies.
 */
async function getFileWithRetry(
  api: Pick<Api, 'getFile'>,
  fileId: string,
  sleepImpl: (ms: number) => Promise<void>,
): ReturnType<Api['getFile']> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await api.getFile(fileId);
    } catch (error) {
      const isLastAttempt = attempt === MAX_ATTEMPTS;
      if (!isRetryableGetFileError(error) || isLastAttempt) throw error;
      await sleepImpl(RETRY_BACKOFF_MS[attempt - 1]!);
    }
  }
  throw new Error('unreachable: exhausted getFile retry attempts');
}

/**
 * Up to MAX_ATTEMPTS, each bounded by a FETCH_TIMEOUT_MS timeout via
 * AbortSignal.timeout. Retries a thrown error (network failure or timeout)
 * or a retry-worthy HTTP status (429/5xx) with the shared backoff
 * schedule. A successful response, or a permanent (non-retryable) HTTP
 * status, is returned as-is on the first occurrence — the caller's
 * existing `!response.ok` check decides success/failure from there,
 * unchanged. On final exhaustion of a thrown error, the original error is
 * rethrown so the caller's existing generic "network error" wrapping still
 * applies; a final retryable status is returned as-is so the caller's
 * existing "Telegram returned HTTP <status>" wrapping still applies.
 */
async function fetchWithRetry(fetchImpl: typeof fetch, url: string, sleepImpl: (ms: number) => Promise<void>): Promise<Response> {
  let lastNetworkError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const isLastAttempt = attempt === MAX_ATTEMPTS;
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (response.ok || !isRetryableHttpStatus(response.status) || isLastAttempt) {
        return response;
      }
      await sleepImpl(RETRY_BACKOFF_MS[attempt - 1]!);
    } catch (error) {
      lastNetworkError = error;
      if (isLastAttempt) throw error;
      await sleepImpl(RETRY_BACKOFF_MS[attempt - 1]!);
    }
  }
  throw lastNetworkError ?? new Error('unreachable: exhausted fetch retry attempts');
}

/**
 * Downloads a Telegram photo into memory only — never written to disk,
 * never put on the Redis queue (which only ever carries the message id).
 * Errors are sanitized: the bot token appears in the download URL but is
 * never included in a thrown message or logged.
 *
 * Both the Telegram metadata lookup (getFile) and the actual file download
 * are bounded, retried (only for retry-worthy transient failures — network
 * errors, timeouts, HTTP 429, HTTP 5xx) up to 3 attempts total with a
 * short backoff, and the file download is additionally bounded by a
 * per-attempt timeout. A permanent failure (bad file id, HTTP 4xx other
 * than 429, etc.) is never retried — it fails exactly as before, on the
 * first attempt.
 */
export async function downloadTelegramPhoto(
  fileId: string,
  options: DownloadTelegramPhotoOptions = {},
): Promise<DownloadedTelegramPhoto> {
  const api = options.api ?? getTelegramFileApi();
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleepImpl = options.sleepImpl ?? defaultSleep;

  let filePath: string;
  try {
    const file = await getFileWithRetry(api, fileId, sleepImpl);
    if (!file.file_path) {
      throw new Error('Telegram did not return a file_path for this file');
    }
    filePath = file.file_path;
  } catch (error) {
    throw new Error(
      `Failed to resolve Telegram file metadata: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }

  const downloadUrl = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`;

  let response: Response;
  try {
    response = await fetchWithRetry(fetchImpl, downloadUrl, sleepImpl);
  } catch {
    throw new Error('Failed to download Telegram file: network error');
  }

  if (!response.ok) {
    throw new Error(`Failed to download Telegram file: Telegram returned HTTP ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return { buffer: Buffer.from(arrayBuffer), mimeType: inferMimeType(filePath) };
}
