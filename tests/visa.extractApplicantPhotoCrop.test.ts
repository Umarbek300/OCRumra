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

// --- document boundary detection (passport-only / background / hand-held / tilted) ---
// See src/visa/detectDocumentBoundary.ts. These scenarios exercise the
// NEW pre-OCR document-isolation layer end to end, on top of the already
// real-passport-verified D=0.11 layout-aware crop (unchanged). No real
// production images exist yet for background/hand-held/tilted Telegram
// photos in this engagement -- these fixtures are deliberately synthetic,
// built from first principles (text/face clustering vs. empty background),
// clearly flagged as such rather than presented as real-passport-derived.

async function makeImage(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 220, g: 220, b: 220 } } })
    .jpeg()
    .toBuffer();
}

test('document boundary: a passport-only image (text/face spanning nearly the whole frame) is a complete no-op', async () => {
  const width = 960;
  const height = 1280;
  const original = await makeImage(width, height);
  const faces = [{ boundingPoly: box(151, 805, 322, 1004), detectionConfidence: 0.95 }];
  const deps = buildDeps(faces);

  // Paragraphs spanning nearly edge-to-edge, as a real full-page Vision
  // response for a passport that fills the frame would.
  const fullPageParagraphs: VisionPage[] = [
    {
      blocks: [
        {
          paragraphs: [
            paragraphFixture('HEADER TEXT ROW', 20, 80, 940, 120),
            paragraphFixture('FAMILIYASI SURNAME', 355, 753, 481, 768),
            paragraphFixture('ABDUVALIEVA', 361, 768, 529, 790),
            paragraphFixture("OTASINING ISMI FATHER'S NAME", 359, 832, 543, 847),
            paragraphFixture('RASHIDOVNA', 365, 849, 516, 868),
            paragraphFixture('MRZ LINE SIMULATED LONG TEXT ROW HERE', 20, 1230, 940, 1260),
          ],
        },
      ],
    },
  ];

  const withoutPages = await extractApplicantPhotoCrop(original, 'image/jpeg', deps);
  const withPages = await extractApplicantPhotoCrop(original, 'image/jpeg', deps, fullPageParagraphs);

  assert.ok(withoutPages && withPages);
  const faceOnlyMeta = await sharp(withoutPages!).metadata();
  const boundaryMeta = await sharp(withPages!).metadata();
  // Document boundary alone (no HIGH-confidence column/MRZ in this sparse
  // fixture) must not shrink the crop below the pure face-only size --
  // a passport filling the frame has no meaningful background to exclude.
  assert.equal(boundaryMeta.width, faceOnlyMeta.width);
  assert.equal(boundaryMeta.height, faceOnlyMeta.height);
});

test('document boundary: a passport photographed with real surrounding background is isolated from that background', async () => {
  const width = 1200;
  const height = 1600;
  const original = await makeImage(width, height);
  // Passport's own face, positioned in the lower-center of the frame.
  const faces = [{ boundingPoly: box(320, 950, 520, 1200), detectionConfidence: 0.95 }];
  const deps = buildDeps(faces);

  const backgroundPages: VisionPage[] = [
    {
      blocks: [
        {
          paragraphs: [
            paragraphFixture('FAMILIYASI SURNAME', 550, 900, 750, 930),
            paragraphFixture('TESTPERSON', 550, 935, 750, 960),
            paragraphFixture('ISMI GIVEN NAMES', 550, 970, 730, 995),
            paragraphFixture('EXAMPLE', 550, 1000, 730, 1025),
            paragraphFixture("OTASINING ISMI FATHER'S NAME", 550, 1040, 800, 1065),
            paragraphFixture('TESTOVICH', 550, 1075, 750, 1100),
            paragraphFixture('P<UZBTESTPERSON<<EXAMPLE<<<<<<<<<<<<<<<<<<<', 400, 1450, 1050, 1490),
            paragraphFixture('FA12345678UZB9001014M30010123456789012345', 400, 1495, 1050, 1530),
          ],
        },
      ],
    },
  ];

  const withoutPages = await extractApplicantPhotoCrop(original, 'image/jpeg', deps);
  const withPages = await extractApplicantPhotoCrop(original, 'image/jpeg', deps, backgroundPages);

  assert.ok(withoutPages && withPages);
  const faceOnlyMeta = await sharp(withoutPages!).metadata();
  const boundaryMeta = await sharp(withPages!).metadata();

  // The face-only crop (no document awareness) on this large canvas would
  // extend well above the real document region into pure background --
  // the boundary-aware crop must be meaningfully shorter/narrower.
  assert.ok(boundaryMeta.height! < faceOnlyMeta.height!, 'boundary-aware crop must exclude background above the document');
});

test('document boundary: a passport held in a hand (a second, larger, unrelated face elsewhere in frame) does not let that face win face selection', async () => {
  const width = 1000;
  const height = 1400;
  const original = await makeImage(width, height);
  // The hand-holder's own face: large, confident, positioned well above
  // the passport -- without document-boundary awareness, this is LARGER
  // in area than the passport's own printed photo and would normally win
  // computeApplicantPhotoCropRegion's "largest confident face" selection.
  const holderFace = { boundingPoly: box(500, 60, 900, 460), detectionConfidence: 0.97 }; // 400x400
  // The passport's own printed photo face: smaller, positioned beside the personal-data column.
  const passportFace = { boundingPoly: box(300, 850, 480, 1100), detectionConfidence: 0.9 }; // 180x250
  const deps = buildDeps([holderFace, passportFace]);

  const handHeldPages: VisionPage[] = [
    {
      blocks: [
        {
          paragraphs: [
            paragraphFixture('FAMILIYASI SURNAME', 480, 850, 700, 880),
            paragraphFixture('HOLDERNAME', 480, 890, 700, 915),
            paragraphFixture('ISMI GIVEN NAMES', 480, 925, 680, 955),
            paragraphFixture('SAMPLE', 480, 960, 680, 985),
            paragraphFixture("OTASINING ISMI FATHER'S NAME", 480, 1000, 760, 1030),
            paragraphFixture('EXAMPLEVICH', 480, 1040, 700, 1070),
          ],
        },
      ],
    },
  ];

  // Sanity check: WITHOUT document-boundary awareness (no pages), the
  // larger holder face wins face selection, anchoring the crop near the
  // TOP of the frame (around the holder's face), not the passport.
  const withoutPages = await extractApplicantPhotoCrop(original, 'image/jpeg', deps);
  assert.ok(withoutPages);
  const withoutPagesMeta = await sharp(withoutPages!).metadata();

  // WITH document-boundary awareness, the holder's face must be excluded
  // from selection (it is far from the text cluster), so the crop is
  // anchored around the SMALLER passport face instead.
  const withPages = await extractApplicantPhotoCrop(original, 'image/jpeg', deps, handHeldPages);
  assert.ok(withPages);

  // Re-crop using ONLY the passport face (ground truth for "correct" selection) for comparison.
  const correctOnlyDeps = buildDeps([passportFace]);
  const correctOnly = await extractApplicantPhotoCrop(original, 'image/jpeg', correctOnlyDeps, handHeldPages);
  assert.ok(correctOnly);

  const withPagesMeta = await sharp(withPages!).metadata();
  const correctOnlyMeta = await sharp(correctOnly!).metadata();

  // The boundary-aware crop (both faces offered) must match the crop
  // produced when ONLY the correct (passport) face was ever offered --
  // proving the holder's face was excluded from selection, not merely
  // outscored by chance.
  assert.equal(withPagesMeta.width, correctOnlyMeta.width);
  assert.equal(withPagesMeta.height, correctOnlyMeta.height);
  // And it must differ from the naive (no-boundary) result, which anchored on the wrong (holder's) face.
  assert.notEqual(withPagesMeta.height, withoutPagesMeta.height);
});

test('document boundary: a tilted/perspective-distorted passport still gets isolated from background (region isolation, NOT perspective rectification)', async () => {
  const width = 1200;
  const height = 1600;
  const original = await makeImage(width, height);
  const faces = [{ boundingPoly: box(340, 1000, 520, 1230), detectionConfidence: 0.93 }];
  const deps = buildDeps(faces);

  // Simulates a tilted photo: paragraph bounding boxes drift diagonally
  // (each row shifted right as it goes down) rather than forming a clean
  // axis-aligned block, the way Vision's own bounding boxes behave for
  // rotated/skewed printed text. This module does NOT dewarp the image --
  // it only computes an axis-aligned union around this tilted cluster, so
  // the resulting boundary is necessarily looser than a true perspective
  // rectification would be. That is a known, reported limitation (see
  // detectDocumentBoundary.ts's own doc comment), not something this test
  // claims to fully solve.
  const tiltedPages: VisionPage[] = [
    {
      blocks: [
        {
          paragraphs: [
            paragraphFixture('FAMILIYASI SURNAME', 560, 940, 760, 975),
            paragraphFixture('TILTEDPERSON', 575, 985, 775, 1020),
            paragraphFixture('ISMI GIVEN NAMES', 590, 1030, 770, 1065),
            paragraphFixture('SKEWED', 605, 1075, 785, 1110),
            paragraphFixture("OTASINING ISMI FATHER'S NAME", 615, 1120, 865, 1155),
            paragraphFixture('EXAMPLEOVNA', 630, 1165, 830, 1200),
          ],
        },
      ],
    },
  ];

  const withoutPages = await extractApplicantPhotoCrop(original, 'image/jpeg', deps);
  const withPages = await extractApplicantPhotoCrop(original, 'image/jpeg', deps, tiltedPages);

  assert.ok(withoutPages && withPages);
  const faceOnlyMeta = await sharp(withoutPages!).metadata();
  const boundaryMeta = await sharp(withPages!).metadata();

  // Even for a tilted cluster, the boundary-aware crop must still exclude
  // the large empty background above/around it -- isolation still works
  // even though the tilt angle itself is never corrected.
  assert.ok(boundaryMeta.height! < faceOnlyMeta.height!, 'boundary-aware crop must still exclude background even for a tilted document cluster');
});
