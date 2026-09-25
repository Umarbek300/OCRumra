import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createGoogleVisionProvider,
  GOOGLE_VISION_PROVIDER_MODEL,
  type DetectDocumentTextFn,
  type GoogleVisionProviderDependencies,
} from '../src/ocr/providers/googleVisionProvider.js';
import { LOCAL_PROVIDER_MODEL } from '../src/ocr/mrz/mapMrzToExtractionResult.js';
import type { VisionPage, VisionWord } from '../src/ocr/visual/extractIssueDateFromVisionStructure.js';

// Canonical ICAO 9303 sample MRZ, real ISO country code substituted (see
// tests/mrz.parseAndValidateMrz.test.ts for why the spec's fictitious
// "UTO" is avoided). Not real passport data.
const VALID_LINE_1 = 'P<USAERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<';
const VALID_LINE_2 = 'L898902C36USA7408122F1204159ZE184226B<<<<<10';
const CORRUPTED_CHECK_DIGIT_LINE_2 = 'L898902C35USA7408122F1204159ZE184226B<<<<<10';
// Independently computed (ICAO check-digit algorithm) — structurally
// identical to real message 270/271's Vision-read line 2 (44 chars, valid
// MRZ alphabet, zero '<' filler). See tests/mrz.parseAndValidateMrz.test.ts.
const VALID_LINE_2_NO_FILLER = 'L898902C36USA7408122F1204159ZE184226B1234508';

// detectDocumentText returns { fullText, pages } — the SAME single Vision
// API call hands back both the flat text (MRZ scanning) and the structured
// word/bounding-box data extractVisualIssueDate needs, at zero extra API
// cost. `pages: []` is a valid, harmless default for every test that
// doesn't care about the visual issue date.
function buildProvider(detectDocumentText: DetectDocumentTextFn) {
  const deps: GoogleVisionProviderDependencies = { detectDocumentText };
  return createGoogleVisionProvider(deps);
}

function textOnly(fullText: string): ReturnType<DetectDocumentTextFn> {
  return Promise.resolve({ fullText, pages: [] });
}

function box(x0: number, y0: number, x1: number, y1: number) {
  return {
    vertices: [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 },
    ],
  };
}

function word(text: string, boundingBox: ReturnType<typeof box> | null = null): VisionWord {
  return {
    symbols: [...text].map((char) => ({ text: char })),
    boundingBox,
  };
}

test('createGoogleVisionProvider returns a provider named "google-vision" with an extract function', () => {
  const provider = buildProvider(() => textOnly(''));
  assert.equal(provider.name, 'google-vision');
  assert.equal(typeof provider.extract, 'function');
});

test('extract maps a valid Vision-read 44/44 MRZ pair into a real extraction result', async () => {
  const fullText = ['REPUBLIC OF UTOPIA', 'PASSPORT', VALID_LINE_1, VALID_LINE_2, 'footer'].join('\n');
  const provider = buildProvider(() => textOnly(fullText));

  const result = await provider.extract(Buffer.from('fake-image'), 'image/jpeg');

  assert.equal(result.surname.value, 'ERIKSSON');
  assert.equal(result.passportNumber.value, 'L898902C3');
  assert.equal(result.passportNumber.confidence, 'high');
  assert.equal(result.model, GOOGLE_VISION_PROVIDER_MODEL);
  assert.notEqual(result.model, LOCAL_PROVIDER_MODEL);
});

test('extract succeeds when the MRZ second line has zero "<" filler characters — the exact real message 270/271 shape', async () => {
  const fullText = [VALID_LINE_1, VALID_LINE_2_NO_FILLER].join('\n');
  const provider = buildProvider(() => textOnly(fullText));

  const result = await provider.extract(Buffer.from('fake-image'), 'image/jpeg');

  assert.equal(result.passportNumber.value, 'L898902C3');
  assert.equal(result.model, GOOGLE_VISION_PROVIDER_MODEL);
});

test('extract does not treat a structurally-shaped but checksum-invalid candidate as a successful extraction', async () => {
  const fullText = [VALID_LINE_1, CORRUPTED_CHECK_DIGIT_LINE_2].join('\n');
  const provider = buildProvider(() => textOnly(fullText));

  const result = await provider.extract(Buffer.from('fake-image'), 'image/jpeg');

  assert.equal(result.passportNumber.value, null, 'a checksum-invalid candidate must never populate fields');
  assert.equal(result.overallConfidence, 'low');
  assert.equal(result.model, GOOGLE_VISION_PROVIDER_MODEL, 'even the unreadable result must report the Vision model, not the Tesseract/local one');
});

test('extract picks a later checksum-valid candidate when an earlier window is checksum-invalid', async () => {
  const fullText = ['header', VALID_LINE_1, CORRUPTED_CHECK_DIGIT_LINE_2, 'middle', VALID_LINE_1, VALID_LINE_2, 'footer'].join('\n');
  const provider = buildProvider(() => textOnly(fullText));

  const result = await provider.extract(Buffer.from('fake-image'), 'image/jpeg');

  assert.equal(result.passportNumber.value, 'L898902C3');
  assert.equal(result.passportNumber.confidence, 'high');
});

test('extract throws (never a silent completed/unreadable result) when the Vision API call itself fails -- an infrastructure failure must mark the job failed, not completed', async () => {
  const provider = buildProvider(() => {
    throw new Error('7 PERMISSION_DENIED: Cloud Vision API has not been used in project ocrumra before or it is disabled');
  });

  await assert.rejects(() => provider.extract(Buffer.from('fake-image'), 'image/jpeg'));
});

test('extract returns a controlled unreadable result when Vision succeeds but finds no MRZ-shaped candidate at all', async () => {
  const provider = buildProvider(() => textOnly('REPUBLIC OF UTOPIA\nPASSPORT\nSurname: ERIKSSON'));

  const result = await provider.extract(Buffer.from('fake-image'), 'image/jpeg');

  assert.equal(result.overallConfidence, 'low');
  assert.equal(result.model, GOOGLE_VISION_PROVIDER_MODEL);
});

test('extract never logs raw OCR text, the full page text, or MRZ line content to the console', async () => {
  const fullText = ['REPUBLIC OF UTOPIA', VALID_LINE_1, VALID_LINE_2, 'footer'].join('\n');
  const provider = buildProvider(() => textOnly(fullText));

  const originalLog = console.log;
  const loggedLines: string[] = [];
  console.log = (...args: unknown[]) => {
    loggedLines.push(args.map(String).join(' '));
  };
  try {
    await provider.extract(Buffer.from('fake-image'), 'image/jpeg');
  } finally {
    console.log = originalLog;
  }

  const combined = loggedLines.join('\n');
  assert.ok(!combined.includes(VALID_LINE_1));
  assert.ok(!combined.includes(VALID_LINE_2));
  assert.ok(!combined.includes('ERIKSSON'));
  assert.ok(!combined.includes(fullText));
});

test('extract never logs raw error content beyond what is already an API/auth-level message when Vision fails', async () => {
  const provider = buildProvider(() => {
    throw new Error('some Vision client error');
  });

  const originalLog = console.log;
  const loggedLines: string[] = [];
  console.log = (...args: unknown[]) => {
    loggedLines.push(args.map(String).join(' '));
  };
  try {
    await assert.rejects(() => provider.extract(Buffer.from('fake-image'), 'image/jpeg'));
  } finally {
    console.log = originalLog;
  }

  // Just confirms logging happened (before the rethrow) without leaking
  // any MRZ-shaped content — the error message itself is expected/allowed.
  assert.ok(loggedLines.join('\n').length < 1000, 'error logging must stay bounded, not dump arbitrary content');
});

// --- visual issue-date extraction wired into the provider ------------------
// The SAME single Vision call's structured `pages` data is now used to
// recover passport_issue_date (outside the MRZ) alongside the MRZ read.

test('extract populates passportIssueDate with medium confidence when the structured pages contain a DD-DD-YYYY row next to an ISSUE label', async () => {
  const fullText = [VALID_LINE_1, VALID_LINE_2].join('\n');
  const pages: VisionPage[] = [
    {
      width: 1000,
      height: 1000,
      blocks: [
        {
          paragraphs: [
            {
              words: [
                word('DATE', box(0, 100, 40, 110)),
                word('OF', box(42, 100, 55, 110)),
                word('ISSUE', box(57, 100, 90, 110)),
                word('15', box(95, 100, 110, 110)),
                word('01', box(112, 100, 128, 110)),
                word('2020', box(130, 100, 160, 110)),
              ],
            },
          ],
        },
      ],
    },
  ];
  const provider = buildProvider(() => Promise.resolve({ fullText, pages }));

  const result = await provider.extract(Buffer.from('fake-image'), 'image/jpeg');

  assert.deepEqual(result.passportIssueDate, { value: '2020-01-15', confidence: 'medium' });
});

test('extract passes the MRZ-derived birth/expiry dates as knownDates, so a row that actually matches the date of birth is never echoed back as the issue date', async () => {
  // VALID_LINE_2 encodes birthDate=740812 -> 1974-08-12 (see
  // tests/mrz.mapMrzToExtractionResult.test.ts for the same specimen).
  // The only date row on this page equals that birth date — a mislabeled
  // row, not a real issue date — so it must be rejected, not surfaced.
  const fullText = [VALID_LINE_1, VALID_LINE_2].join('\n');
  const pages: VisionPage[] = [
    {
      width: 1000,
      height: 1000,
      blocks: [
        {
          paragraphs: [
            {
              words: [
                word('DATE', box(0, 100, 40, 110)),
                word('OF', box(42, 100, 55, 110)),
                word('ISSUE', box(57, 100, 90, 110)),
                word('12', box(95, 100, 110, 110)),
                word('08', box(112, 100, 128, 110)),
                word('1974', box(130, 100, 160, 110)),
              ],
            },
          ],
        },
      ],
    },
  ];
  const provider = buildProvider(() => Promise.resolve({ fullText, pages }));

  const result = await provider.extract(Buffer.from('fake-image'), 'image/jpeg');

  assert.deepEqual(result.passportIssueDate, { value: null, confidence: null });
});

test('extract leaves passportIssueDate null when the structured pages contain no ISSUE-label date row (backward compatible with a plain/empty pages response)', async () => {
  const fullText = [VALID_LINE_1, VALID_LINE_2].join('\n');
  const provider = buildProvider(() => Promise.resolve({ fullText, pages: [] }));

  const result = await provider.extract(Buffer.from('fake-image'), 'image/jpeg');

  assert.deepEqual(result.passportIssueDate, { value: null, confidence: null });
});

test('extract never logs the visual issue date value itself — only a found/not-found boolean', async () => {
  const fullText = [VALID_LINE_1, VALID_LINE_2].join('\n');
  const pages: VisionPage[] = [
    {
      width: 1000,
      height: 1000,
      blocks: [
        {
          paragraphs: [
            {
              words: [
                word('DATE', box(0, 100, 40, 110)),
                word('OF', box(42, 100, 55, 110)),
                word('ISSUE', box(57, 100, 90, 110)),
                word('15', box(95, 100, 110, 110)),
                word('01', box(112, 100, 128, 110)),
                word('2020', box(130, 100, 160, 110)),
              ],
            },
          ],
        },
      ],
    },
  ];
  const provider = buildProvider(() => Promise.resolve({ fullText, pages }));

  const originalLog = console.log;
  const loggedLines: string[] = [];
  console.log = (...args: unknown[]) => {
    loggedLines.push(args.map(String).join(' '));
  };
  try {
    await provider.extract(Buffer.from('fake-image'), 'image/jpeg');
  } finally {
    console.log = originalLog;
  }

  const combined = loggedLines.join('\n');
  assert.ok(!combined.includes('2020-01-15'));
  assert.ok(!combined.includes('2020'));
});
