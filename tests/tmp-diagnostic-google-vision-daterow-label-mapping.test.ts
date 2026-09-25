import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  computeNearestRowPerCategory,
  extractBlockWordDetails,
  extractLabelWordsFromPages,
  findDateRows,
  type VisionPage,
  type VisionWord,
} from '../scripts/tmp-diagnostic-google-vision-daterow-label-mapping.js';

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

function buildPageAtBlock19(paragraphs: { words: VisionWord[] }[]): VisionPage {
  const blocks = Array.from({ length: 20 }, () => ({ paragraphs: [] as { words: VisionWord[] }[] }));
  blocks[19] = { paragraphs };
  return { blocks, width: 1000, height: 1000 };
}

test('findDateRows recognizes a DD-DD-YYYY triple aligned on the same horizontal row', () => {
  const words = [
    word('DATE', box(0, 100, 40, 110)),
    word('OF', box(42, 100, 55, 110)),
    word('BIRTH', box(57, 100, 90, 110)),
    word('15', box(95, 100, 110, 110)),
    word('05', box(112, 101, 128, 111)),
    word('1990', box(130, 100, 160, 110)),
  ];
  const pages: VisionPage[] = [buildPageAtBlock19([{ words }])];
  const details = extractBlockWordDetails(pages, 19);
  const rows = findDateRows(details);

  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.words[0]!.length, 2);
  assert.equal(rows[0]!.words[1]!.length, 2);
  assert.equal(rows[0]!.words[2]!.length, 4);
  assert.equal(rows[0]!.yAlignmentSpread < 0.03, true);
});

test('findDateRows rejects a DD-DD-YYYY-shaped triple that is NOT vertically aligned (different rows, coincidental shape match)', () => {
  const words = [
    word('15', box(0, 100, 15, 110)),
    word('05', box(20, 500, 35, 510)), // far below -> not the same visual row
    word('1990', box(40, 100, 70, 110)),
  ];
  const pages: VisionPage[] = [buildPageAtBlock19([{ words }])];
  const details = extractBlockWordDetails(pages, 19);
  const rows = findDateRows(details);
  assert.equal(rows.length, 0);
});

test('findDateRows ignores a merged single word instead of three separate digit words (no false positive)', () => {
  const words = [word('DATE', box(0, 100, 40, 110)), word('15051990', box(50, 100, 110, 110))];
  const pages: VisionPage[] = [buildPageAtBlock19([{ words }])];
  const details = extractBlockWordDetails(pages, 19);
  const rows = findDateRows(details);
  assert.equal(rows.length, 0);
});

test('extractLabelWordsFromPages finds BIRTH/ISSUE/EXPIRY category words case-insensitively and ignores unrelated words', () => {
  const words = [
    word('Date', box(0, 0, 10, 10)),
    word('of', box(12, 0, 20, 10)),
    word('Birth', box(22, 0, 40, 10)),
    word('DOE', box(42, 0, 55, 10)),
    word('ISSUED', box(57, 0, 90, 10)),
    word('Expiry', box(92, 0, 110, 10)),
  ];
  const pages: VisionPage[] = [buildPageAtBlock19([{ words }])];
  const labelWords = extractLabelWordsFromPages(pages, 19);
  const categories = labelWords.map((w) => w.category).sort();
  assert.deepEqual(categories, ['BIRTH', 'EXPIRY', 'ISSUE', 'OTHER_LABEL', 'OTHER_LABEL']);
});

test('computeNearestRowPerCategory correctly maps 3 distinct date rows to BIRTH/ISSUE/EXPIRY by spatial proximity', () => {
  const paragraphs = [
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
  ];
  const pages: VisionPage[] = [buildPageAtBlock19(paragraphs)];
  const details = extractBlockWordDetails(pages, 19);
  const labelWords = extractLabelWordsFromPages(pages, 19);
  const rows = findDateRows(details);
  assert.equal(rows.length, 3);

  const nearest = computeNearestRowPerCategory(rows, labelWords);
  assert.equal(nearest.BIRTH?.rowIndex, 0);
  assert.equal(nearest.ISSUE?.rowIndex, 1);
  assert.equal(nearest.EXPIRY?.rowIndex, 2);
  // BIRTH/ISSUE/EXPIRY labels are directly adjacent to their own row -> small distance.
  assert.equal(nearest.BIRTH!.distance < 0.1, true);
  assert.equal(nearest.ISSUE!.distance < 0.1, true);
  assert.equal(nearest.EXPIRY!.distance < 0.1, true);
});

test('computeNearestRowPerCategory returns null for a category with no matching label word found', () => {
  const words = [
    word('DATE', box(0, 0, 40, 10)),
    word('OF', box(42, 0, 55, 10)),
    word('ISSUE', box(57, 0, 90, 10)),
    word('15', box(95, 0, 110, 10)),
    word('01', box(112, 0, 128, 10)),
    word('2020', box(130, 0, 160, 10)),
  ];
  const pages: VisionPage[] = [buildPageAtBlock19([{ words }])];
  const details = extractBlockWordDetails(pages, 19);
  const labelWords = extractLabelWordsFromPages(pages, 19);
  const rows = findDateRows(details);
  const nearest = computeNearestRowPerCategory(rows, labelWords);
  assert.equal(nearest.BIRTH, null);
  assert.equal(nearest.EXPIRY, null);
  assert.notEqual(nearest.ISSUE, null);
});

test('formatDateRowLabelReport output never contains the actual matched digits/letters from the words — only structural fields and the fixed BIRTH/ISSUE/EXPIRY category vocabulary it defines itself', async () => {
  const { formatDateRowLabelReport } = await import('../scripts/tmp-diagnostic-google-vision-daterow-label-mapping.js');
  const words = [
    word('DATE', box(0, 0, 40, 10)),
    word('OF', box(42, 0, 55, 10)),
    word('BIRTH', box(57, 0, 90, 10)),
    word('15', box(95, 0, 110, 10)),
    word('01', box(112, 0, 128, 10)),
    word('2020', box(130, 0, 160, 10)),
  ];
  const pages: VisionPage[] = [buildPageAtBlock19([{ words }])];
  const details = extractBlockWordDetails(pages, 19);
  const labelWords = extractLabelWordsFromPages(pages, 19);
  const rows = findDateRows(details);
  const nearest = computeNearestRowPerCategory(rows, labelWords);
  const report = formatDateRowLabelReport(rows, labelWords, nearest);
  // "2020" is the actual matched digit content from a word — must never appear verbatim.
  assert.equal(report.includes('2020'), false);
  // The fixed category vocabulary (e.g. "BIRTH:") IS expected to appear — it's a label
  // this script defines itself, not text read from the passport.
  assert.equal(report.includes('BIRTH'), true);
});
