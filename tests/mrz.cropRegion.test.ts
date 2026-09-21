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

test('cropRegion defaults to a 2x upscale when scale is not specified (unchanged production behavior)', async () => {
  const image = await makeGradientImage(200, 100);
  const cropped = await cropRegion(image, 0, 100);

  const metadata = await sharp(cropped).metadata();
  assert.equal(metadata.width, 400); // 200 * 2 (default)
});

test('cropRegion applies a 3x upscale when scale: 3 is specified', async () => {
  const image = await makeGradientImage(200, 100);
  const cropped = await cropRegion(image, 0, 100, { scale: 3 });

  const metadata = await sharp(cropped).metadata();
  assert.equal(metadata.width, 600); // 200 * 3
});

test('cropRegion applies a 4x upscale when scale: 4 is specified', async () => {
  const image = await makeGradientImage(200, 100);
  const cropped = await cropRegion(image, 0, 100, { scale: 4 });

  const metadata = await sharp(cropped).metadata();
  assert.equal(metadata.width, 800); // 200 * 4
});

async function countWhitePixels(binarizedImage: Buffer): Promise<number> {
  const { data, info } = await sharp(binarizedImage).raw().toBuffer({ resolveWithObject: true });
  let white = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    if (data[i] === 255) white += 1;
  }
  return white;
}

test('cropRegion defaults binarize to the existing threshold (150) when threshold is not specified', async () => {
  const image = await makeGradientImage(200, 100);
  const defaultThreshold = await cropRegion(image, 0, 100, { binarize: true });
  const explicit150 = await cropRegion(image, 0, 100, { binarize: true, threshold: 150 });

  assert.equal(await countWhitePixels(defaultThreshold), await countWhitePixels(explicit150));
});

test('cropRegion respects a custom binarization threshold: a lower threshold classifies more pixels as white', async () => {
  const image = await makeGradientImage(200, 100);

  const threshold120 = await cropRegion(image, 0, 100, { binarize: true, threshold: 120 });
  const threshold150 = await cropRegion(image, 0, 100, { binarize: true, threshold: 150 });
  const threshold180 = await cropRegion(image, 0, 100, { binarize: true, threshold: 180 });

  const white120 = await countWhitePixels(threshold120);
  const white150 = await countWhitePixels(threshold150);
  const white180 = await countWhitePixels(threshold180);

  assert.ok(white120 > white150, `threshold 120 (${white120} white px) should classify more pixels white than 150 (${white150})`);
  assert.ok(white150 > white180, `threshold 150 (${white150} white px) should classify more pixels white than 180 (${white180})`);
});

test('cropRegion combines a custom scale with a custom threshold', async () => {
  const image = await makeGradientImage(200, 100);
  const cropped = await cropRegion(image, 0, 100, { binarize: true, scale: 3, threshold: 120 });

  const metadata = await sharp(cropped).metadata();
  assert.equal(metadata.width, 600); // 200 * 3

  const { data, info } = await sharp(cropped).raw().toBuffer({ resolveWithObject: true });
  const distinctValues = new Set<number>();
  for (let i = 0; i < data.length; i += info.channels) {
    distinctValues.add(data[i]!);
  }
  assert.ok(distinctValues.size <= 2, 'still strictly two-tone when binarized at a non-default scale');
});
