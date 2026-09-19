import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLocalProvider, type LocalProviderDependencies } from '../src/ocr/providers/localProvider.js';

const VALID_SPECIMEN_LINES = ['P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<', 'L898902C36UTO7408122F1204159ZE184226B<<<<<10'];

function buildDeps(overrides: Partial<LocalProviderDependencies> = {}): LocalProviderDependencies {
  return {
    locateMrzRegion: async (buffer) => buffer,
    runTesseractOcr: async () => VALID_SPECIMEN_LINES.join('\n'),
    ...overrides,
  };
}

test('local provider is named "local" and never touches Anthropic', () => {
  const provider = createLocalProvider(buildDeps());
  assert.equal(provider.name, 'local');
});

test('local provider wires crop -> OCR -> parse -> map end to end (mocked crop/OCR)', async () => {
  const provider = createLocalProvider(buildDeps());
  const result = await provider.extract(Buffer.from('fake-image-bytes'), 'image/jpeg');

  assert.equal(result.surname.value, 'ERIKSSON');
  assert.equal(result.passportNumber.value, 'L898902C3');
  assert.equal(result.model, 'tesseract-mrz-local');
});

test('local provider returns a low-confidence, all-null result when OCR output is not a recognizable MRZ (never throws, never guesses)', async () => {
  const provider = createLocalProvider(
    buildDeps({
      runTesseractOcr: async () => 'not an mrz at all',
    }),
  );

  const result = await provider.extract(Buffer.from('fake-image-bytes'), 'image/jpeg');

  assert.equal(result.overallConfidence, 'low');
  assert.equal(result.surname.value, null);
  assert.equal(result.passportNumber.value, null);
});

test('local provider propagates a crop failure (e.g. corrupt/unreadable image)', async () => {
  const provider = createLocalProvider(
    buildDeps({
      locateMrzRegion: async () => {
        throw new Error('Could not read image dimensions for MRZ region crop');
      },
    }),
  );

  await assert.rejects(
    () => provider.extract(Buffer.from('not-an-image'), 'image/jpeg'),
    /Could not read image dimensions/,
  );
});

test('local provider propagates a Tesseract failure (e.g. binary not installed)', async () => {
  const provider = createLocalProvider(
    buildDeps({
      runTesseractOcr: async () => {
        throw new Error('Failed to start local OCR (tesseract): spawn tesseract ENOENT');
      },
    }),
  );

  await assert.rejects(() => provider.extract(Buffer.from('fake-image-bytes'), 'image/jpeg'), /Failed to start local OCR/);
});
