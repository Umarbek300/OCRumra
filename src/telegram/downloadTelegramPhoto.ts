import { Api } from 'grammy';
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
}

/**
 * Downloads a Telegram photo into memory only — never written to disk,
 * never put on the Redis queue (which only ever carries the message id).
 * Errors are sanitized: the bot token appears in the download URL but is
 * never included in a thrown message or logged.
 */
export async function downloadTelegramPhoto(
  fileId: string,
  options: DownloadTelegramPhotoOptions = {},
): Promise<DownloadedTelegramPhoto> {
  const api = options.api ?? getTelegramFileApi();
  const fetchImpl = options.fetchImpl ?? fetch;

  let filePath: string;
  try {
    const file = await api.getFile(fileId);
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
    response = await fetchImpl(downloadUrl);
  } catch {
    throw new Error('Failed to download Telegram file: network error');
  }

  if (!response.ok) {
    throw new Error(`Failed to download Telegram file: Telegram returned HTTP ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return { buffer: Buffer.from(arrayBuffer), mimeType: inferMimeType(filePath) };
}
