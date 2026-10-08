import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { extractApplicantPhotoCrop, type ExtractApplicantPhotoCropDependencies } from '../src/visa/extractApplicantPhotoCrop.js';
import type { VisionFaceAnnotation } from '../src/visa/computeApplicantPhotoCropRegion.js';
import type { VisionPage } from '../src/ocr/visual/extractIssueDateFromVisionStructure.js';

const IMAGE_WIDTH = 800;
const IMAGE_HEIGHT = 1000;

async function makeSyntheticPassportImage(): Promise<Buffer> {
  return sharp({
    create: { width: IMAGE_WIDTH, height: IMAGE_HEIGHT, channels: 3, background: { r: 230, g: 230, b: 230 } },
  })
    .jpeg()
    .toBuffer();
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

function buildDeps(faces: VisionFaceAnnotation[], calls?: { count: number }): ExtractApplicantPhotoCropDependencies {
  return {
    detectFaces: async () => {
      if (calls) calls.count += 1;
      return { faces };
    },
  };
}

test('extractApplicantPhotoCrop returns a cropped buffer smaller than the original when a confident face is found', async () => {
  const original = await makeSyntheticPassportImage();
  const faces = [{ boundingPoly: box(100, 100, 220, 220), detectionConfidence: 0.95 }];
  const deps = buildDeps(faces);

  const cropped = await extractApplicantPhotoCrop(original, 'image/jpeg', deps);

  assert.ok(cropped, 'expected a non-null cropped buffer');
  assert.notEqual(cropped!.toString('base64'), original.toString('base64'), 'the cropped output must differ from the original full-passport image');

  const croppedMeta = await sharp(cropped!).metadata();
  assert.ok(croppedMeta.width! < IMAGE_WIDTH, 'the crop must be narrower than the original full-passport image');
  assert.ok(croppedMeta.height! < IMAGE_HEIGHT, 'the crop must be shorter than the original full-passport image');
});

test('extractApplicantPhotoCrop returns null when Vision finds no faces at all — never falls back to the original image', async () => {
  const original = await makeSyntheticPassportImage();
  const deps = buildDeps([]);

  const cropped = await extractApplicantPhotoCrop(original, 'image/jpeg', deps);

  assert.equal(cropped, null);
});

test('extractApplicantPhotoCrop returns null when every detected face is below the confidence threshold', async () => {
  const original = await makeSyntheticPassportImage();
  const faces = [{ boundingPoly: box(100, 100, 220, 220), detectionConfidence: 0.1 }];
  const deps = buildDeps(faces);

  const cropped = await extractApplicantPhotoCrop(original, 'image/jpeg', deps);

  assert.equal(cropped, null);
});

test('extractApplicantPhotoCrop rethrows (never returns null silently) when the Vision face-detection call itself fails', async () => {
  const original = await makeSyntheticPassportImage();
  const deps: ExtractApplicantPhotoCropDependencies = {
    detectFaces: async () => {
      throw new Error('7 PERMISSION_DENIED: Cloud Vision API has not been used in project ocrumra before or it is disabled');
    },
  };

  await assert.rejects(() => extractApplicantPhotoCrop(original, 'image/jpeg', deps));
});

test('extractApplicantPhotoCrop calls detectFaces exactly once per invocation (one Vision call, never more)', async () => {
  const original = await makeSyntheticPassportImage();
  const faces = [{ boundingPoly: box(100, 100, 220, 220), detectionConfidence: 0.95 }];
  const calls = { count: 0 };
  const deps = buildDeps(faces, calls);

  await extractApplicantPhotoCrop(original, 'image/jpeg', deps);

  assert.equal(calls.count, 1);
});

test('extractApplicantPhotoCrop outputs a PNG buffer when mimeType is image/png', async () => {
  const original = await sharp({
    create: { width: IMAGE_WIDTH, height: IMAGE_HEIGHT, channels: 3, background: { r: 200, g: 200, b: 200 } },
  })
    .png()
    .toBuffer();
  const faces = [{ boundingPoly: box(100, 100, 220, 220), detectionConfidence: 0.95 }];
  const deps = buildDeps(faces);

  const cropped = await extractApplicantPhotoCrop(original, 'image/png', deps);

  assert.ok(cropped);
  const meta = await sharp(cropped!).metadata();
  assert.equal(meta.format, 'png');
});

test('extractApplicantPhotoCrop outputs a WebP buffer when mimeType is image/webp', async () => {
  const original = await sharp({
    create: { width: IMAGE_WIDTH, height: IMAGE_HEIGHT, channels: 3, background: { r: 200, g: 200, b: 200 } },
  })
    .webp()
    .toBuffer();
  const faces = [{ boundingPoly: box(100, 100, 220, 220), detectionConfidence: 0.95 }];
  const deps = buildDeps(faces);

  const cropped = await extractApplicantPhotoCrop(original, 'image/webp', deps);

  assert.ok(cropped);
  const meta = await sharp(cropped!).metadata();
  assert.equal(meta.format, 'webp');
});

test('extractApplicantPhotoCrop defaults to JPEG output for an unrecognized mimeType', async () => {
  const original = await makeSyntheticPassportImage();
  const faces = [{ boundingPoly: box(100, 100, 220, 220), detectionConfidence: 0.95 }];
  const deps = buildDeps(faces);

  const cropped = await extractApplicantPhotoCrop(original, 'application/octet-stream', deps);

  assert.ok(cropped);
  const meta = await sharp(cropped!).metadata();
  assert.equal(meta.format, 'jpeg');
});

test('extractApplicantPhotoCrop produces a crop whose pixel region stays within the (EXIF-normalized) image bounds for a rotated input', async () => {
  // Build a wide (landscape, 1000x800) image and tag it with EXIF
  // orientation 6 (rotate 90deg CW on display) — sharp's rotate() with no
  // arguments physically applies that tag, so the EFFECTIVE image this
  // function operates on becomes a tall 800x1000 portrait, matching how a
  // phone camera's sideways-held JPEG is normally displayed.
  const landscape = await sharp({
    create: { width: 1000, height: 800, channels: 3, background: { r: 210, g: 210, b: 210 } },
  })
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer();

  // After a 90deg CW rotation, pixel (x,y) in the original landscape maps
  // near (height-1-y, x) in the rotated/display frame. A face placed at
  // roughly the center of the ROTATED (800x1000) frame is used so this
  // assertion doesn't depend on exactly reproducing that transform by hand.
  const faces = [{ boundingPoly: box(350, 450, 450, 550), detectionConfidence: 0.95 }];
  const deps = buildDeps(faces);

  const cropped = await extractApplicantPhotoCrop(landscape, 'image/jpeg', deps);

  assert.ok(cropped, 'expected a crop to be produced for an EXIF-rotated input');
  const meta = await sharp(cropped!).metadata();
  // The rotated/display frame is 800 wide x 1000 tall — the crop must fit
  // inside that normalized frame, not the original un-rotated 1000x800 buffer.
  assert.ok(meta.width! <= 800, 'crop width must fit within the EXIF-normalized (post-rotation) frame width');
  assert.ok(meta.height! <= 1000, 'crop height must fit within the EXIF-normalized (post-rotation) frame height');
});

// --- layout-aware crop (optional 4th argument, textDetectionPages) --------
// Real production passport 381 geometry (960x1280), transcribed verbatim
// from this engagement's own read-only Vision diagnostic — see
// tests/visa.detectPersonalDataColumn.test.ts and
// tests/mrz.locateMrzParagraphGeometry.test.ts for the same fixture used at
// the unit level. This proves the full wiring (pages -> coordinate
// transform -> column/MRZ detection -> layout constraints ->
// computeApplicantPhotoCropRegion) end to end, not just each piece alone.

function paragraphFixture(text: string, x0: number, y0: number, x1: number, y1: number) {
  return {
    words: [{ symbols: [...text].map((ch) => ({ text: ch })) }],
    boundingBox: box(x0, y0, x1, y1),
  };
}

const REAL_381_TEXT_DETECTION_PAGES: VisionPage[] = [
  {
    blocks: [
      {
        paragraphs: [
          paragraphFixture(
            'P<UZBIBRAGIMOVA<<MARYAM<BOTIROVNA<<<<<<<<<FA93188091UZB1803127F290314961203180005077',
            42,
            1135,
            821,
            1222,
          ),
          paragraphFixture('FAMILIYASI SURNAME', 314, 738, 448, 750),
          paragraphFixture('IBRAGIMOVA', 317, 753, 477, 773),
          paragraphFixture("OTASINING ISMI FATHER'S NAME", 312, 823, 511, 838),
          paragraphFixture('BOTIROVNA', 315, 840, 463, 860),
          paragraphFixture('FUQAROLIGI NATIONALITY', 313, 867, 477, 882),
          paragraphFixture('UZBEKISTAN', 312, 884, 447, 903),
          paragraphFixture("TUG'ILGAN SANASI DATE OF BIRTH", 312, 908, 528, 920),
          paragraphFixture('12 03 2018', 316, 921, 478, 941),
          paragraphFixture('BERILGAN SANASH DATE OF ISSUE 15 03 2024', 311, 1011, 523, 1049),
          paragraphFixture('AMAL QILISH MUDDATI DATE OF EXPIRY 14 03 2029', 310, 1055, 554, 1094),
        ],
      },
    ],
  },
];

async function makePassport381SizedImage(): Promise<Buffer> {
  return sharp({
    create: { width: 960, height: 1280, channels: 3, background: { r: 230, g: 230, b: 230 } },
  })
    .jpeg()
    .toBuffer();
}

test('extractApplicantPhotoCrop applies real 381 layout constraints when textDetectionPages is provided, producing a strictly smaller crop than the face-only base', async () => {
  const original = await makePassport381SizedImage();
  const faces = [{ boundingPoly: box(60, 776, 264, 1014), detectionConfidence: 0.98828125 }];
  const deps = buildDeps(faces);

  const baseCropped = await extractApplicantPhotoCrop(original, 'image/jpeg', deps);
  const layoutCropped = await extractApplicantPhotoCrop(original, 'image/jpeg', deps, REAL_381_TEXT_DETECTION_PAGES);

  assert.ok(baseCropped);
  assert.ok(layoutCropped);
  const baseMeta = await sharp(baseCropped!).metadata();
  const layoutMeta = await sharp(layoutCropped!).metadata();

  assert.ok(layoutMeta.width! < baseMeta.width!, 'the personal-data column constraint must shrink the crop width');
  assert.ok(layoutMeta.height! < baseMeta.height!, 'the MRZ constraint must shrink the crop height');
});

test('extractApplicantPhotoCrop behaves exactly like the 3-argument call when textDetectionPages is omitted (backward compatibility)', async () => {
  const original = await makePassport381SizedImage();
  const faces = [{ boundingPoly: box(60, 776, 264, 1014), detectionConfidence: 0.98828125 }];
  const deps = buildDeps(faces);

  const withoutArg = await extractApplicantPhotoCrop(original, 'image/jpeg', deps);
  const withUndefined = await extractApplicantPhotoCrop(original, 'image/jpeg', deps, undefined);

  assert.ok(withoutArg && withUndefined);
  assert.deepEqual(withoutArg!.toString('base64'), withUndefined!.toString('base64'));
});

test('extractApplicantPhotoCrop falls back to the face-only crop when textDetectionPages is an empty array', async () => {
  const original = await makePassport381SizedImage();
  const faces = [{ boundingPoly: box(60, 776, 264, 1014), detectionConfidence: 0.98828125 }];
  const deps = buildDeps(faces);

  const base = await extractApplicantPhotoCrop(original, 'image/jpeg', deps);
  const withEmptyPages = await extractApplicantPhotoCrop(original, 'image/jpeg', deps, []);

  assert.ok(base && withEmptyPages);
  assert.deepEqual(base!.toString('base64'), withEmptyPages!.toString('base64'));
});

test('extractApplicantPhotoCrop never throws when textDetectionPages is malformed — it falls back to the face-only crop instead', async () => {
  const original = await makePassport381SizedImage();
  const faces = [{ boundingPoly: box(60, 776, 264, 1014), detectionConfidence: 0.98828125 }];
  const deps = buildDeps(faces);

  const base = await extractApplicantPhotoCrop(original, 'image/jpeg', deps);
  // A deliberately malformed page (paragraphs is not an array) must never
  // crash the portrait pipeline — layout detection is a pure enhancement.
  const malformedPages = [{ blocks: [{ paragraphs: 'not-an-array' as unknown as [] }] }] as unknown as VisionPage[];
  const withMalformed = await extractApplicantPhotoCrop(original, 'image/jpeg', deps, malformedPages);

  assert.ok(base && withMalformed);
  assert.deepEqual(base!.toString('base64'), withMalformed!.toString('base64'));
});
