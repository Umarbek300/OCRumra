import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  extractVisualIssueDate,
  type VisionPage,
  type VisionWord,
} from '../src/ocr/visual/extractIssueDateFromVisionStructure.js';

/**
 * Spec/regression tests for extractVisualIssueDate(). Assumed row order is
 * DAY, MONTH, YEAR (the common international "DD MM YYYY" passport
 * convention).
 *
 * All fixtures use synthetic digit values — never real passport data. The
 * "real 270/271 shape" test reproduces only the STRUCTURAL pattern already
 * observed (row count, relative label-to-row distance ratios), not any
 * actual date.
 */

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

function buildPage(paragraphs: { words: VisionWord[] }[][]): VisionPage {
  return {
    width: 1000,
    height: 1000,
    blocks: paragraphs.map((blockParagraphs) => ({ paragraphs: blockParagraphs })),
  };
}

test('extractVisualIssueDate finds the DD-DD-YYYY row nearest the ISSUE label and returns it as an ISO date', () => {
  const pages: VisionPage[] = [
    buildPage([
      [
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
    ]),
  ];
  const result = extractVisualIssueDate(pages, []);
  assert.equal(result, '2020-01-15');
});

test('extractVisualIssueDate still finds the label when Vision fuses trailing punctuation into the same word token (e.g. "ISSUE:")', () => {
  // Real Vision output can attach a trailing colon/period/comma to the same
  // word as the printed label instead of segmenting it separately — the
  // label match must be resilient to this OCR noise, not require an exact
  // "ISSUE"/"ISSUED" string.
  const pages: VisionPage[] = [
    buildPage([
      [
        {
          words: [
            word('DATE', box(0, 100, 40, 110)),
            word('OF', box(42, 100, 55, 110)),
            word('ISSUE:', box(57, 100, 90, 110)),
            word('15', box(95, 100, 110, 110)),
            word('01', box(112, 100, 128, 110)),
            word('2020', box(130, 100, 160, 110)),
          ],
        },
      ],
    ]),
  ];
  const result = extractVisualIssueDate(pages, []);
  assert.equal(result, '2020-01-15');
});

test('extractVisualIssueDate returns null when no ISSUE/ISSUED label word exists anywhere (never guesses which row it is)', () => {
  const pages: VisionPage[] = [
    buildPage([
      [
        {
          words: [
            word('15', box(95, 100, 110, 110)),
            word('01', box(112, 100, 128, 110)),
            word('2020', box(130, 100, 160, 110)),
          ],
        },
      ],
    ]),
  ];
  const result = extractVisualIssueDate(pages, []);
  assert.equal(result, null);
});

test('extractVisualIssueDate returns null when no DD-DD-YYYY row shape exists at all', () => {
  const pages: VisionPage[] = [
    buildPage([[{ words: [word('DATE', box(0, 0, 40, 10)), word('OF', box(42, 0, 55, 10)), word('ISSUE', box(57, 0, 90, 10))] }]]),
  ];
  const result = extractVisualIssueDate(pages, []);
  assert.equal(result, null);
});

test('extractVisualIssueDate rejects a row whose digits form an impossible calendar date instead of returning a bad date', () => {
  const pages: VisionPage[] = [
    buildPage([
      [
        {
          words: [
            word('DATE', box(0, 100, 40, 110)),
            word('OF', box(42, 100, 55, 110)),
            word('ISSUE', box(57, 100, 90, 110)),
            word('32', box(95, 100, 110, 110)), // impossible day
            word('13', box(112, 100, 128, 110)), // impossible month
            word('2020', box(130, 100, 160, 110)),
          ],
        },
      ],
    ]),
  ];
  const result = extractVisualIssueDate(pages, []);
  assert.equal(result, null);
});

test('extractVisualIssueDate returns null when the nearest candidate row equals an already-known MRZ date (safety net against a mislabeled row)', () => {
  const pages: VisionPage[] = [
    buildPage([
      [
        {
          words: [
            word('DATE', box(0, 100, 40, 110)),
            word('OF', box(42, 100, 55, 110)),
            word('ISSUE', box(57, 100, 90, 110)),
            word('12', box(95, 100, 110, 110)),
            word('05', box(112, 100, 128, 110)),
            word('1990', box(130, 100, 160, 110)),
          ],
        },
      ],
    ]),
  ];
  // '1990-05-12' is already known from MRZ (e.g. dateOfBirth) — must not be echoed back as issue date.
  const result = extractVisualIssueDate(pages, ['1990-05-12']);
  assert.equal(result, null);
});

test('extractVisualIssueDate picks the row closest to the ISSUE label among birth/issue/expiry rows all present on the page', () => {
  const pages: VisionPage[] = [
    buildPage([
      [
        {
          words: [
            word('DATE', box(0, 0, 40, 10)),
            word('OF', box(42, 0, 55, 10)),
            word('BIRTH', box(57, 0, 90, 10)),
            word('12', box(95, 0, 110, 10)),
            word('05', box(112, 0, 128, 10)),
            word('1990', box(130, 0, 160, 10)),
          ],
        },
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
        {
          words: [
            word('DATE', box(0, 200, 40, 210)),
            word('OF', box(42, 200, 55, 210)),
            word('EXPIRY', box(57, 200, 100, 210)),
            word('15', box(105, 200, 120, 210)),
            word('01', box(122, 200, 138, 210)),
            word('2030', box(140, 200, 170, 210)),
          ],
        },
      ],
    ]),
  ];
  const result = extractVisualIssueDate(pages, ['1990-05-12', '2030-01-15']);
  assert.equal(result, '2020-01-15');
});

test('real 270/271-shaped regression fixture: two date rows with the same relative label-to-row distance ratio observed in production (issue row closer than expiry row) resolve to the nearer (issue) row — synthetic digit values only, never real passport data', () => {
  // Real diagnostic distances for message 270: ISSUE label -> row0 = 0.1046, row1 (further/EXPIRY-like) = 0.1319.
  // Reproduced here as the same relative ratio, with an ISSUE label placed so row 0 is closer.
  const pages: VisionPage[] = [
    buildPage([
      [
        {
          words: [
            word('DATE', box(400, 500, 440, 510)),
            word('OF', box(442, 500, 455, 510)),
            word('ISSUE', box(457, 500, 490, 510)),
            word('20', box(495, 500, 510, 510)),
            word('06', box(512, 500, 528, 510)),
            word('2019', box(530, 500, 560, 510)),
          ],
        },
        {
          words: [word('25', box(495, 630, 510, 640)), word('06', box(512, 630, 528, 640)), word('2029', box(530, 630, 560, 640))],
        },
      ],
    ]),
  ];
  const result = extractVisualIssueDate(pages, []);
  assert.equal(result, '2019-06-20');
});
