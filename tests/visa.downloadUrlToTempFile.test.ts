import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { cleanupDownloadedTempFile, downloadUrlToTempFile } from '../src/visa/downloadUrlToTempFile.js';

/**
 * Package 5.27: a generic network/file utility, unrelated to any portal
 * DOM -- tested against a tiny LOCAL HTTP server (this process's own,
 * ephemeral), never any real or third-party endpoint. No database, no
 * Redis, no VisitSaudi involved.
 */

const SAMPLE_BYTES = Buffer.from('not a real jpeg, just deterministic test bytes 12345');

let server: Server;
let baseUrl: string;

before(async () => {
  server = createServer((req, res) => {
    if (req.url === '/ok.jpg') {
      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      res.end(SAMPLE_BYTES);
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('test server did not bind to a port');
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('downloadUrlToTempFile writes the exact response bytes to a new local file', async () => {
  const filePath = await downloadUrlToTempFile(`${baseUrl}/ok.jpg`, 'portrait.jpg');
  try {
    const written = await readFile(filePath);
    assert.ok(written.equals(SAMPLE_BYTES), 'downloaded file content must exactly match the server response');
    assert.ok(filePath.endsWith('portrait.jpg'));
  } finally {
    await cleanupDownloadedTempFile(filePath);
  }
});

test('downloadUrlToTempFile throws clearly on a non-2xx response, never writes an error page as if it were the image', async () => {
  await assert.rejects(() => downloadUrlToTempFile(`${baseUrl}/missing.jpg`, 'portrait.jpg'), /404/);
});

test('cleanupDownloadedTempFile removes the file so it cannot be reused by mistake', async () => {
  const filePath = await downloadUrlToTempFile(`${baseUrl}/ok.jpg`, 'portrait.jpg');
  await cleanupDownloadedTempFile(filePath);
  await assert.rejects(() => readFile(filePath));
});

test('cleanupDownloadedTempFile is a safe no-op for a path that was already removed, never throws', async () => {
  const filePath = await downloadUrlToTempFile(`${baseUrl}/ok.jpg`, 'portrait.jpg');
  await cleanupDownloadedTempFile(filePath);
  await assert.doesNotReject(() => cleanupDownloadedTempFile(filePath));
});
