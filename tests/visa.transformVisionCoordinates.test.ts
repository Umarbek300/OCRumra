import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  flattenParagraphsToNormalizedSpace,
  normalizedDimensions,
  transformPointToNormalizedSpace,
  type RawImageGeometry,
} from '../src/visa/transformVisionCoordinates.js';
import type { VisionPage } from '../src/ocr/visual/extractIssueDateFromVisionStructure.js';

// A 1000(w) x 800(h) raw landscape image — the four raw corners are tracked
// through each orientation by hand (see transformVisionCoordinates.ts's own
// doc comment for the derivation), rather than trusting the formulas
// in isolation.
const RAW_WIDTH = 1000;
const RAW_HEIGHT = 800;

function geometry(orientation: number | undefined): RawImageGeometry {
  return { rawWidth: RAW_WIDTH, rawHeight: RAW_HEIGHT, orientation };
}

test('transformPointToNormalizedSpace is the identity transform for orientation 1 (normal)', () => {
  const g = geometry(1);
  assert.deepEqual(transformPointToNormalizedSpace({ x: 100, y: 200 }, g), { x: 100, y: 200 });
});

test('transformPointToNormalizedSpace is the identity transform when orientation is undefined (treated as normal)', () => {
  const g = geometry(undefined);
  assert.deepEqual(transformPointToNormalizedSpace({ x: 100, y: 200 }, g), { x: 100, y: 200 });
});

test('transformPointToNormalizedSpace orientation 3 (180°) maps each raw corner to its diagonal opposite', () => {
  const g = geometry(3);
  assert.deepEqual(transformPointToNormalizedSpace({ x: 0, y: 0 }, g), { x: RAW_WIDTH, y: RAW_HEIGHT });
  assert.deepEqual(transformPointToNormalizedSpace({ x: RAW_WIDTH, y: 0 }, g), { x: 0, y: RAW_HEIGHT });
  assert.deepEqual(transformPointToNormalizedSpace({ x: 0, y: RAW_HEIGHT }, g), { x: RAW_WIDTH, y: 0 });
  assert.deepEqual(transformPointToNormalizedSpace({ x: RAW_WIDTH, y: RAW_HEIGHT }, g), { x: 0, y: 0 });
});

test('transformPointToNormalizedSpace orientation 6 (rotate 90° CW) maps raw top-left to normalized top-right', () => {
  const g = geometry(6);
  // Raw top-left (0,0) ends up at the top-right of the rotated (800x1000) frame.
  assert.deepEqual(transformPointToNormalizedSpace({ x: 0, y: 0 }, g), { x: RAW_HEIGHT, y: 0 });
  // Raw top-right (1000,0) ends up at the bottom-right of the rotated frame.
  assert.deepEqual(transformPointToNormalizedSpace({ x: RAW_WIDTH, y: 0 }, g), { x: RAW_HEIGHT, y: RAW_WIDTH });
  // Raw bottom-left (0,800) ends up at the top-left of the rotated frame.
  assert.deepEqual(transformPointToNormalizedSpace({ x: 0, y: RAW_HEIGHT }, g), { x: 0, y: 0 });
});

test('transformPointToNormalizedSpace orientation 8 (rotate 270° CW) maps raw top-left to normalized bottom-left', () => {
  const g = geometry(8);
  // Raw top-left (0,0) ends up at the bottom-left of the rotated (800x1000) frame.
  assert.deepEqual(transformPointToNormalizedSpace({ x: 0, y: 0 }, g), { x: 0, y: RAW_WIDTH });
  // Raw top-right (1000,0) ends up at the top-left of the rotated frame.
  assert.deepEqual(transformPointToNormalizedSpace({ x: RAW_WIDTH, y: 0 }, g), { x: 0, y: 0 });
});

test('orientation 6 (90° CW) and orientation 8 (270° CW) rotate the same raw point to different normalized positions', () => {
  const point = { x: 123, y: 456 };
  const rotatedCW = transformPointToNormalizedSpace(point, geometry(6));
  const rotatedCCW = transformPointToNormalizedSpace(point, geometry(8));
  assert.notDeepEqual(rotatedCW, rotatedCCW);
  // Both stay within the rotated (800x1000) frame's own bounds.
  for (const p of [rotatedCW, rotatedCCW]) {
    assert.ok(p.x >= 0 && p.x <= RAW_HEIGHT);
    assert.ok(p.y >= 0 && p.y <= RAW_WIDTH);
  }
});

test('normalizedDimensions swaps width/height for a 90°/270° orientation and leaves them unchanged for normal/180°', () => {
  assert.deepEqual(normalizedDimensions(geometry(1)), { width: RAW_WIDTH, height: RAW_HEIGHT });
  assert.deepEqual(normalizedDimensions(geometry(3)), { width: RAW_WIDTH, height: RAW_HEIGHT });
  assert.deepEqual(normalizedDimensions(geometry(6)), { width: RAW_HEIGHT, height: RAW_WIDTH });
  assert.deepEqual(normalizedDimensions(geometry(8)), { width: RAW_HEIGHT, height: RAW_WIDTH });
});

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

test('flattenParagraphsToNormalizedSpace extracts text and bbox unchanged when orientation is normal (1)', () => {
  const pages: VisionPage[] = [
    {
      blocks: [
        {
          paragraphs: [
            { words: [{ symbols: [{ text: 'I' }, { text: 'B' }, { text: 'R' }] }], boundingBox: box(100, 200, 300, 250) },
          ],
        },
      ],
    },
  ];
  const result = flattenParagraphsToNormalizedSpace(pages, geometry(1));
  assert.equal(result.length, 1);
  assert.equal(result[0]?.text, 'IBR');
  assert.deepEqual(result[0], { text: 'IBR', x0: 100, y0: 200, x1: 300, y1: 250 });
});

test('flattenParagraphsToNormalizedSpace transforms bbox coordinates for a rotated (90° CW) raw image', () => {
  const pages: VisionPage[] = [
    { blocks: [{ paragraphs: [{ words: [{ symbols: [{ text: 'X' }] }], boundingBox: box(0, 0, 100, 50) }] }] },
  ];
  const result = flattenParagraphsToNormalizedSpace(pages, geometry(6));
  assert.equal(result.length, 1);
  // Raw box (0,0)-(100,50) under orientation 6: corners map to (800,0),(800,100),(750,100),(750,0) -> normalized bbox x0=750,y0=0,x1=800,y1=100
  assert.deepEqual(result[0], { text: 'X', x0: 750, y0: 0, x1: 800, y1: 100 });
});

test('flattenParagraphsToNormalizedSpace skips a paragraph with no bounding box rather than guessing', () => {
  const pages: VisionPage[] = [{ blocks: [{ paragraphs: [{ words: [{ symbols: [{ text: 'X' }] }], boundingBox: null }] }] }];
  const result = flattenParagraphsToNormalizedSpace(pages, geometry(1));
  assert.equal(result.length, 0);
});

test('flattenParagraphsToNormalizedSpace joins multiple words with a space, matching this engagement\'s own real-passport diagnostic scripts', () => {
  const pages: VisionPage[] = [
    {
      blocks: [
        {
          paragraphs: [
            {
              words: [
                { symbols: [{ text: 'I' }, { text: 'B' }], boundingBox: box(0, 0, 10, 10) },
                { symbols: [{ text: 'R' }], boundingBox: box(12, 0, 20, 10) },
              ],
              boundingBox: box(0, 0, 20, 10),
            },
          ],
        },
      ],
    },
  ];
  const result = flattenParagraphsToNormalizedSpace(pages, geometry(1));
  assert.equal(result[0]?.text, 'IB R');
});
