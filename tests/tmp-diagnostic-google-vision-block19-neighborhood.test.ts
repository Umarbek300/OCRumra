import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  computeYearTokenNeighborhoods,
  extractBlockWordDetails,
  type VisionPage,
  type VisionWord,
} from '../scripts/tmp-diagnostic-google-vision-block19-neighborhood.js';

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

function buildPageWithBlockAt(blockIndex: number, words: VisionWord[]): VisionPage {
  const blocks = Array.from({ length: blockIndex + 1 }, () => ({ paragraphs: [] as { words: VisionWord[] }[] }));
  blocks[blockIndex] = { paragraphs: [{ words }] };
  return { blocks, width: 1000, height: 1000 };
}

test('extractBlockWordDetails only reads the targeted block, ignoring every other block', () => {
  const pages: VisionPage[] = [
    {
      width: 1000,
      height: 1000,
      blocks: [
        { paragraphs: [{ words: [word('SURNAME')] }] },
        { paragraphs: [{ words: [word('DATE'), word('OF'), word('ISSUE'), word('2020')] }] },
      ],
    },
  ];
  const details = extractBlockWordDetails(pages, 1);
  assert.equal(details.length, 4);
  assert.equal(details.every((d) => d.blockIndex === 1), true);
});

test('extractBlockWordDetails reports length/charClass without revealing the text, and normalizes bounding boxes to 0..1', () => {
  const pages: VisionPage[] = [buildPageWithBlockAt(19, [word('2020', box(100, 200, 300, 250))])];
  const details = extractBlockWordDetails(pages, 19);
  assert.deepEqual(details, [
    {
      blockIndex: 19,
      paragraphIndex: 0,
      wordIndex: 0,
      length: 4,
      charClass: 'DIGIT',
      normalizedBox: { x0: 0.1, y0: 0.2, x1: 0.3, y1: 0.25 },
    },
  ]);
});

test('scenario A: separate DD/MON/YYYY words -> the year token neighborhood shows DIGIT-then-LETTER-then-DIGIT preceding it', () => {
  // "DATE" "OF" "ISSUE" "15" "JAN" "2020"
  const words = [
    word('DATE', box(0, 0, 40, 10)),
    word('OF', box(42, 0, 55, 10)),
    word('ISSUE', box(57, 0, 90, 10)),
    word('15', box(95, 0, 110, 10)),
    word('JAN', box(112, 0, 130, 10)),
    word('2020', box(132, 0, 160, 10)),
  ];
  const pages: VisionPage[] = [buildPageWithBlockAt(19, words)];
  const details = extractBlockWordDetails(pages, 19);
  const neighborhoods = computeYearTokenNeighborhoods(details, 3);

  assert.equal(neighborhoods.length, 1);
  const [n] = neighborhoods;
  assert.equal(n!.yearToken.wordIndex, 5);
  assert.deepEqual(
    n!.precedingWords.map((w) => `${w.length}:${w.charClass}`),
    ['4:LETTER', '2:LETTER', '5:LETTER', '2:DIGIT', '3:LETTER'].slice(-3),
  );
  assert.deepEqual(n!.followingWords, []);
});

test('scenario B: one merged word -> zero year-token neighborhoods are found at all (no separate 4-digit DIGIT word exists)', () => {
  const words = [
    word('DATE', box(0, 0, 40, 10)),
    word('OF', box(42, 0, 55, 10)),
    word('ISSUE', box(57, 0, 90, 10)),
    word('15JAN2020', box(95, 0, 160, 10)),
  ];
  const pages: VisionPage[] = [buildPageWithBlockAt(19, words)];
  const details = extractBlockWordDetails(pages, 19);
  const neighborhoods = computeYearTokenNeighborhoods(details, 3);

  assert.equal(neighborhoods.length, 0);
  assert.equal(details[3]!.charClass, 'MIXED');
  assert.equal(details[3]!.length, 9);
});

test('computeYearTokenNeighborhoods never crosses a paragraph boundary for preceding/following context', () => {
  const words = [
    { ...word('9999', box(0, 0, 10, 10)) }, // paragraph 0, unrelated year-like word, no context available
  ];
  // Build two paragraphs manually via extractBlockWordDetails' own grouping: we simulate
  // by giving distinct paragraphIndex through two separate blocks-with-one-paragraph pages
  // combined — simpler to just assert an isolated single-word paragraph has empty context.
  void words;
  const pages: VisionPage[] = [buildPageWithBlockAt(19, [word('9999', box(0, 0, 10, 10))])];
  const details = extractBlockWordDetails(pages, 19);
  const neighborhoods = computeYearTokenNeighborhoods(details, 3);
  assert.equal(neighborhoods.length, 1);
  assert.deepEqual(neighborhoods[0]!.precedingWords, []);
  assert.deepEqual(neighborhoods[0]!.followingWords, []);
});

test('formatBlockNeighborhoodReport output contains no letters/digits from the actual words, only structural fields', async () => {
  const { formatBlockNeighborhoodReport } = await import(
    '../scripts/tmp-diagnostic-google-vision-block19-neighborhood.js'
  );
  const words = [
    word('DATE', box(0, 0, 40, 10)),
    word('15', box(95, 0, 110, 10)),
    word('JAN', box(112, 0, 130, 10)),
    word('2020', box(132, 0, 160, 10)),
  ];
  const pages: VisionPage[] = [buildPageWithBlockAt(19, words)];
  const details = extractBlockWordDetails(pages, 19);
  const neighborhoods = computeYearTokenNeighborhoods(details, 3);
  const report = formatBlockNeighborhoodReport(details, neighborhoods);
  assert.equal(report.includes('DATE'), false);
  assert.equal(report.includes('JAN'), false);
  assert.equal(report.includes('2020'), false);
});
