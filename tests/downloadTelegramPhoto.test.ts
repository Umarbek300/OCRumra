import assert from 'node:assert/strict';
import { test } from 'node:test';
import { downloadTelegramPhoto } from '../src/telegram/downloadTelegramPhoto.js';

function mockFetchOk(bytes: Uint8Array): typeof fetch {
  return (async () =>
    new Response(bytes, { status: 200 })) as unknown as typeof fetch;
}

test('downloadTelegramPhoto returns the image bytes and an inferred mime type on success', async () => {
  const fakeBytes = new Uint8Array([1, 2, 3, 4]);
  const result = await downloadTelegramPhoto('FILE_ID_123', {
    api: { getFile: async () => ({ file_id: 'FILE_ID_123', file_unique_id: 'u1', file_path: 'photos/file_1.jpg' }) },
    fetchImpl: mockFetchOk(fakeBytes),
  });

  assert.ok(Buffer.isBuffer(result.buffer));
  assert.equal(result.buffer.length, 4);
  assert.deepEqual([...result.buffer], [1, 2, 3, 4]);
  assert.equal(result.mimeType, 'image/jpeg');
});

test('downloadTelegramPhoto infers mime type from the file extension', async () => {
  const result = await downloadTelegramPhoto('FILE_ID_PNG', {
    api: { getFile: async () => ({ file_id: 'FILE_ID_PNG', file_unique_id: 'u2', file_path: 'docs/scan.png' }) },
    fetchImpl: mockFetchOk(new Uint8Array([9])),
  });
  assert.equal(result.mimeType, 'image/png');
});

test('downloadTelegramPhoto throws a clean error when Telegram getFile fails', async () => {
  await assert.rejects(
    () =>
      downloadTelegramPhoto('BAD_FILE_ID', {
        api: {
          getFile: async () => {
            throw new Error('Bad Request: file not found');
          },
        },
        fetchImpl: mockFetchOk(new Uint8Array()),
      }),
    /Failed to resolve Telegram file metadata/,
  );
});

test('downloadTelegramPhoto throws a clean error when Telegram omits file_path', async () => {
  await assert.rejects(
    () =>
      downloadTelegramPhoto('NO_PATH_FILE_ID', {
        api: { getFile: async () => ({ file_id: 'NO_PATH_FILE_ID', file_unique_id: 'u3' }) },
        fetchImpl: mockFetchOk(new Uint8Array()),
      }),
    /Failed to resolve Telegram file metadata/,
  );
});

test('downloadTelegramPhoto throws a clean error when the file download HTTP request fails', async () => {
  await assert.rejects(
    () =>
      downloadTelegramPhoto('FILE_ID_404', {
        api: { getFile: async () => ({ file_id: 'FILE_ID_404', file_unique_id: 'u4', file_path: 'photos/gone.jpg' }) },
        fetchImpl: (async () => new Response(null, { status: 404 })) as unknown as typeof fetch,
      }),
    /Telegram returned HTTP 404/,
  );
});

test('downloadTelegramPhoto throws a clean error on a network failure, without leaking the bot token', async () => {
  await assert.rejects(async () => {
    try {
      await downloadTelegramPhoto('FILE_ID_NET_FAIL', {
        api: { getFile: async () => ({ file_id: 'FILE_ID_NET_FAIL', file_unique_id: 'u5', file_path: 'photos/x.jpg' }) },
        fetchImpl: (async () => {
          throw new Error('getaddrinfo ENOTFOUND api.telegram.org');
        }) as unknown as typeof fetch,
      });
    } catch (error) {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Failed to download Telegram file: network error/);
      throw error;
    }
  });
});
