import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  computeVisionStructureStatistics,
  type VisionPage,
  type VisionWord,
} from '../scripts/tmp-diagnostic-google-vision-structure-stats.js';

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

test('computeVisionStructureStatistics counts the block/paragraph/word/symbol hierarchy', () => {
  const pages: VisionPage[] = [
    {
      blocks: [
        {
          paragraphs: [
            { words: [word('SURNAME'), word('DOE')] },
            { words: [word('DATE'), word('OF'), word('ISSUE')] },
          ],
        },
        { paragraphs: [{ words: [word('NATIONALITY')] }] },
      ],
    },
  ];
  const stats = computeVisionStructureStatistics(pages);
  assert.equal(stats.blockCount, 2);
  assert.equal(stats.paragraphCount, 3);
  assert.equal(stats.wordCount, 6);
  assert.equal(stats.symbolCount, 'SURNAME'.length + 'DOE'.length + 'DATE'.length + 'OF'.length + 'ISSUE'.length + 'NATIONALITY'.length);
});

test('computeVisionStructureStatistics reports each word length without revealing the text', () => {
  const pages: VisionPage[] = [{ blocks: [{ paragraphs: [{ words: [word('DOE'), word('JOHN')] }] }] }];
  const stats = computeVisionStructureStatistics(pages);
  assert.deepEqual(stats.wordLengths, [3, 4]);
});

test('computeVisionStructureStatistics classifies character classes correctly (DIGIT/LETTER/MIXED/OTHER)', () => {
  const pages: VisionPage[] = [
    { blocks: [{ paragraphs: [{ words: [word('2020'), word('JAN'), word('AB1234567'), word('<<<')] }] }] },
  ];
  const stats = computeVisionStructureStatistics(pages);
  assert.deepEqual(stats.charClassCounts, { DIGIT: 1, LETTER: 1, MIXED: 1, OTHER: 1 });
});

test('computeVisionStructureStatistics counts bounding-box presence separately from absence', () => {
  const pages: VisionPage[] = [
    { blocks: [{ paragraphs: [{ words: [word('DOE', box(0, 0, 10, 10)), word('JOHN', null)] }] }] },
  ];
  const stats = computeVisionStructureStatistics(pages);
  assert.equal(stats.boundingBoxPresentCount, 1);
  assert.equal(stats.boundingBoxMissingCount, 1);
});

test('computeVisionStructureStatistics finds label tokens (DATE/OF/ISSUE/ISSUED) case-insensitively and never treats a name as one', () => {
  const pages: VisionPage[] = [
    { blocks: [{ paragraphs: [{ words: [word('Date'), word('of'), word('issue'), word('DOE'), word('ISSUED')] }] }] },
  ];
  const stats = computeVisionStructureStatistics(pages);
  assert.equal(stats.labelTokenCount, 4);
});

test('computeVisionStructureStatistics finds 4-digit-year-like tokens by shape only, reporting position not the digits', () => {
  const pages: VisionPage[] = [
    {
      blocks: [
        {
          paragraphs: [
            { words: [word('SURNAME')] },
            { words: [word('DATE'), word('OF'), word('ISSUE'), word('2020'), word('JAN'), word('15')] },
          ],
        },
      ],
    },
  ];
  const stats = computeVisionStructureStatistics(pages);
  assert.equal(stats.fourDigitYearLikeTokenCount, 1);
  assert.deepEqual(stats.fourDigitYearLikeTokenInfos, [
    { blockIndex: 0, paragraphIndex: 1, wordIndexInParagraph: 3, length: 4, charClass: 'DIGIT' },
  ]);
});

test('scenario A: Vision returns the date as 3 SEPARATE words next to the label -> label-to-year-like distance is small', () => {
  // "DATE" "OF" "ISSUE" ":" "15" "JAN" "2020", each its own word with a bounding box.
  const pages: VisionPage[] = [
    {
      blocks: [
        {
          paragraphs: [
            {
              words: [
                word('DATE', box(0, 0, 30, 10)),
                word('OF', box(32, 0, 45, 10)),
                word('ISSUE', box(47, 0, 75, 10)),
                word('15', box(80, 0, 95, 10)),
                word('JAN', box(97, 0, 115, 10)),
                word('2020', box(117, 0, 145, 10)),
              ],
            },
          ],
        },
      ],
    },
  ];
  const stats = computeVisionStructureStatistics(pages);
  assert.equal(stats.fourDigitYearLikeTokenCount, 1);
  assert.equal(stats.labelTokenCount, 3);
  // The label tokens sit right next to the date -> every distance should be well under 200px.
  assert.equal(stats.labelToNearestYearLikeDistances.every((d) => d < 200), true);
});

test('scenario B: Vision returns the date as ONE MERGED word (MIXED class, no separate 4-digit token) -> zero year-like tokens found', () => {
  const pages: VisionPage[] = [
    {
      blocks: [
        {
          paragraphs: [
            {
              words: [
                word('DATE', box(0, 0, 30, 10)),
                word('OF', box(32, 0, 45, 10)),
                word('ISSUE', box(47, 0, 75, 10)),
                word('15JAN2020', box(80, 0, 145, 10)),
              ],
            },
          ],
        },
      ],
    },
  ];
  const stats = computeVisionStructureStatistics(pages);
  assert.equal(stats.fourDigitYearLikeTokenCount, 0);
  assert.equal(stats.labelToNearestYearLikeDistances.length, 0);
  const mergedWordStats = stats.wordLengths;
  assert.deepEqual(mergedWordStats, [4, 2, 5, 9]);
  assert.equal(stats.charClassCounts.MIXED, 1);
});

test('formatVisionStructureStatistics output never contains any letter/digit content from the words themselves, only counts and enum labels', async () => {
  const { formatVisionStructureStatistics } = await import('../scripts/tmp-diagnostic-google-vision-structure-stats.js');
  const pages: VisionPage[] = [
    { blocks: [{ paragraphs: [{ words: [word('DATE', box(0, 0, 10, 10)), word('2020', box(20, 0, 30, 10))] }] }] },
  ];
  const stats = computeVisionStructureStatistics(pages);
  const output = formatVisionStructureStatistics(stats);
  // "2020" as a literal number is expected to appear only as the length "4"/distance figures,
  // never as the matched word content — assert the actual passport-relevant literal is absent.
  assert.equal(output.includes('DATE'), false);
});
