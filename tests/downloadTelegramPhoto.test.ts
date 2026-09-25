import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GrammyError, HttpError } from 'grammy';
import { downloadTelegramPhoto } from '../src/telegram/downloadTelegramPhoto.js';

function mockFetchOk(bytes: Uint8Array): typeof fetch {
  return (async () =>
    new Response(bytes, { status: 200 })) as unknown as typeof fetch;
}

/** Skips real backoff delays — every retry test injects this so the suite stays fast. */
const noDelay = async (): Promise<void> => {};

function grammyError(errorCode: number): GrammyError {
  return new GrammyError('Telegram API error', { ok: false, error_code: errorCode, description: 'simulated' }, 'getFile', {});
}

function httpError(): HttpError {
  return new HttpError('Network request failed', new Error('ECONNRESET'));
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
        sleepImpl: noDelay,
      });
    } catch (error) {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Failed to download Telegram file: network error/);
      throw error;
    }
  });
});

// --- retry/timeout behavior --------------------------------------------

test('(a) getFile: a transient network failure (HttpError) on the first attempt is retried, and a second-attempt success is returned', async () => {
  let calls = 0;
  const result = await downloadTelegramPhoto('FILE_ID_RETRY_NET', {
    api: {
      getFile: async () => {
        calls++;
        if (calls === 1) throw httpError();
        return { file_id: 'FILE_ID_RETRY_NET', file_unique_id: 'u6', file_path: 'photos/ok.jpg' };
      },
    },
    fetchImpl: mockFetchOk(new Uint8Array([7])),
    sleepImpl: noDelay,
  });

  assert.equal(calls, 2, 'getFile must have been retried exactly once after the first failure');
  assert.equal(result.mimeType, 'image/jpeg');
});

test('(b) getFile: a 429 (GrammyError) on the first attempt is retried, and a second-attempt success is returned', async () => {
  let calls = 0;
  const result = await downloadTelegramPhoto('FILE_ID_RETRY_429', {
    api: {
      getFile: async () => {
        calls++;
        if (calls === 1) throw grammyError(429);
        return { file_id: 'FILE_ID_RETRY_429', file_unique_id: 'u7', file_path: 'photos/ok.jpg' };
      },
    },
    fetchImpl: mockFetchOk(new Uint8Array([7])),
    sleepImpl: noDelay,
  });

  assert.equal(calls, 2, 'getFile must have been retried exactly once after the 429');
  assert.equal(result.mimeType, 'image/jpeg');
});

test('(c) fetch: an HTTP 500 on the first attempt is retried, and a second-attempt success is returned', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    if (calls === 1) return new Response(null, { status: 500 });
    return new Response(new Uint8Array([7]), { status: 200 });
  }) as unknown as typeof fetch;

  const result = await downloadTelegramPhoto('FILE_ID_RETRY_500', {
    api: { getFile: async () => ({ file_id: 'FILE_ID_RETRY_500', file_unique_id: 'u8', file_path: 'photos/ok.jpg' }) },
    fetchImpl,
    sleepImpl: noDelay,
  });

  assert.equal(calls, 2, 'fetch must have been retried exactly once after the 500');
  assert.equal(result.mimeType, 'image/jpeg');
});

test('(d) getFile: a permanent 4xx (GrammyError, not 429) is never retried and fails on the first attempt', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      downloadTelegramPhoto('FILE_ID_PERMANENT_4XX', {
        api: {
          getFile: async () => {
            calls++;
            throw grammyError(400);
          },
        },
        fetchImpl: mockFetchOk(new Uint8Array()),
        sleepImpl: noDelay,
      }),
    /Failed to resolve Telegram file metadata/,
  );
  assert.equal(calls, 1, 'a permanent 4xx must never be retried');
});

test('(e) fetch: a timeout/abort on the first attempt is retried, and a second-attempt success is returned', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    if (calls === 1) {
      throw new DOMException('The operation timed out.', 'TimeoutError');
    }
    return new Response(new Uint8Array([7]), { status: 200 });
  }) as unknown as typeof fetch;

  const result = await downloadTelegramPhoto('FILE_ID_RETRY_TIMEOUT', {
    api: { getFile: async () => ({ file_id: 'FILE_ID_RETRY_TIMEOUT', file_unique_id: 'u9', file_path: 'photos/ok.jpg' }) },
    fetchImpl,
    sleepImpl: noDelay,
  });

  assert.equal(calls, 2, 'a timeout must have been retried exactly once');
  assert.equal(result.mimeType, 'image/jpeg');
});

test('(f) fetch: all 3 attempts failing (HTTP 500 every time) produces a final, clean failure after exactly 3 attempts', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return new Response(null, { status: 500 });
  }) as unknown as typeof fetch;

  await assert.rejects(
    () =>
      downloadTelegramPhoto('FILE_ID_ALWAYS_500', {
        api: { getFile: async () => ({ file_id: 'FILE_ID_ALWAYS_500', file_unique_id: 'u10', file_path: 'photos/ok.jpg' }) },
        fetchImpl,
        sleepImpl: noDelay,
      }),
    /Telegram returned HTTP 500/,
  );
  assert.equal(calls, 3, 'must attempt exactly 3 times total before giving up');
});
