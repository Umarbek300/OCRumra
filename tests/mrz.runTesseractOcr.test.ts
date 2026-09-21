import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runTesseractOcr } from '../src/ocr/mrz/runTesseractOcr.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Stands in for the real `tesseract` binary: echoes its argv to stdout, so
// these tests can assert on exactly which CLI flags were passed without
// needing tesseract installed.
const ECHO_ARGS_SCRIPT = path.join(__dirname, 'fixtures', 'echo-args.sh');

test('runTesseractOcr defaults to --psm 6', async () => {
  const output = await runTesseractOcr(Buffer.from('fake-image'), { binaryPath: ECHO_ARGS_SCRIPT });
  assert.match(output, /--psm 6/);
});

test('runTesseractOcr applies the MRZ whitelist by default', async () => {
  const output = await runTesseractOcr(Buffer.from('fake-image'), { binaryPath: ECHO_ARGS_SCRIPT });
  assert.match(output, /tessedit_char_whitelist=/);
});

test('runTesseractOcr omits the whitelist when useWhitelist is false', async () => {
  const output = await runTesseractOcr(Buffer.from('fake-image'), { binaryPath: ECHO_ARGS_SCRIPT, useWhitelist: false });
  assert.doesNotMatch(output, /tessedit_char_whitelist=/);
});

test('runTesseractOcr does not pass an --oem flag by default (preserves the tesseract binary’s own default engine mode)', async () => {
  const output = await runTesseractOcr(Buffer.from('fake-image'), { binaryPath: ECHO_ARGS_SCRIPT });
  assert.doesNotMatch(output, /--oem/);
});

test('runTesseractOcr passes --oem <value> when oem is specified', async () => {
  const output = await runTesseractOcr(Buffer.from('fake-image'), { binaryPath: ECHO_ARGS_SCRIPT, oem: 1 });
  assert.match(output, /--oem 1/);
});

test('runTesseractOcr combines oem with psm and the whitelist correctly', async () => {
  const output = await runTesseractOcr(Buffer.from('fake-image'), {
    binaryPath: ECHO_ARGS_SCRIPT,
    psm: 7,
    oem: 1,
    useWhitelist: true,
  });
  assert.match(output, /--psm 7/);
  assert.match(output, /--oem 1/);
  assert.match(output, /tessedit_char_whitelist=/);
});
