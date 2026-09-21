import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { cropRegion } from '../src/ocr/mrz/cropRegion.js';

async function makeGradientImage(width: number, height: number): Promise<Buffer> {
  // A horizontal gradient gives binarize() something real to threshold —
  // a flat color image would look identical before/after.
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value = Math.round((x / (width - 1)) * 255);
      const offset = (y * width + x) * 3;
      raw[offset] = value;
      raw[offset + 1] = value;
      raw[offset + 2] = value;
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

test('cropRegion produces a 2x-upscaled crop of the requested pixel region', async () => {
  const image = await makeGradientImage(200, 300);
  const cropped = await cropRegion(image, 100, 100);

  const metadata = await sharp(cropped).metadata();
  // sharp's resize({width}) with no explicit height preserves aspect
  // ratio, so height scales by the same 2x factor — matching the
  // original (unchanged) locateMrzRegion.ts behavior this generalizes.
  assert.equal(metadata.width, 400); // 200 * 2
  assert.equal(metadata.height, 200); // 100 * 2
});

test('cropRegion with binarize produces a strictly two-tone (black/white) image', async () => {
  const image = await makeGradientImage(200, 100);
  const binarized = await cropRegion(image, 0, 100, { binarize: true });

  const { data, info } = await sharp(binarized).raw().toBuffer({ resolveWithObject: true });
  const distinctValues = new Set<number>();
  for (let i = 0; i < data.length; i += info.channels) {
    distinctValues.add(data[i]!);
  }

  assert.ok(distinctValues.size <= 2, `binarized image should have at most 2 distinct pixel values, got ${distinctValues.size}`);
});

test('cropRegion without binarize keeps a gradient (many distinct pixel values)', async () => {
  const image = await makeGradientImage(200, 100);
  const plain = await cropRegion(image, 0, 100);

  const { data, info } = await sharp(plain).raw().toBuffer({ resolveWithObject: true });
  const distinctValues = new Set<number>();
  for (let i = 0; i < data.length; i += info.channels) {
    distinctValues.add(data[i]!);
  }

  assert.ok(distinctValues.size > 10, 'plain (non-binarized) output should retain a range of tones');
});
