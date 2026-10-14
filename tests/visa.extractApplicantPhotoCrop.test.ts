import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import {
  buildColumnDetectionContext,
  extractApplicantPhotoCrop,
  type ExtractApplicantPhotoCropDependencies,
} from '../src/visa/extractApplicantPhotoCrop.js';
import { computeApplicantPhotoCropRegion, type VisionFaceAnnotation } from '../src/visa/computeApplicantPhotoCropRegion.js';
import { detectPersonalDataColumn, type LayoutParagraph } from '../src/visa/detectPersonalDataColumn.js';
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

// --- A/C/D: the 433 regression (RIGHT constraint survives margin retuning
// and the aspect-ratio step) ------------------------------------------------
// Real production passport 381 geometry (960x1280, same fixture as
// REAL_381_TEXT_DETECTION_PAGES above), reused here to pin down the exact
// mechanism behind a real regression this engagement fixed: narrowing
// computeApplicantPhotoCropRegion.ts's own TOP_MARGIN_FACTOR/
// BOTTOM_MARGIN_FACTOR must never shrink the search window
// detectPersonalDataColumn() is given (that window is now the fixed,
// independent buildColumnDetectionContext -- see extractApplicantPhotoCrop.ts),
// and an already-applied RIGHT constraint must survive the later
// aspect-ratio step even when reaching ratio 0.78 would want more width.

test('A: buildColumnDetectionContext uses the fixed legacy factors (0.9 top / 0.7 bottom / 0.55 side), computed purely from faceBox -- never from the final crop region', () => {
  const faceBox = { x0: 100, y0: 200, x1: 300, y1: 500 }; // faceWidth=200, faceHeight=300
  const context = buildColumnDetectionContext(faceBox);

  assert.deepEqual(context, {
    x0: 100 - 200 * 0.55,
    x1: 300 + 200 * 0.55,
    y0: 200 - 300 * 0.9,
    y1: 500 + 300 * 0.7,
  });
});

test('A: buildColumnDetectionContext never coincides with what a baseRegion-derived window would be -- proving the decoupling this fix relies on', () => {
  const faceBox = { x0: 139, y0: 746, x1: 341, y1: 981 }; // real passport 406 face geometry
  const faces = [{ boundingPoly: box(139, 746, 341, 981), detectionConfidence: 0.988 }];
  const baseRegion = computeApplicantPhotoCropRegion(faces, 960, 1280);
  assert.ok(baseRegion);

  const context = buildColumnDetectionContext(faceBox);
  // Before this fix, detectPersonalDataColumn's search window WAS exactly
  // this baseRegion-shaped box -- tied to whatever
  // TOP_MARGIN_FACTOR/BOTTOM_MARGIN_FACTOR happen to be. It must not
  // coincide with that any more.
  const oldStyleWindowFromBaseRegion = {
    x0: baseRegion!.left,
    y0: baseRegion!.top,
    x1: baseRegion!.left + baseRegion!.width,
    y1: baseRegion!.top + baseRegion!.height,
  };
  assert.notDeepEqual(context, oldStyleWindowFromBaseRegion);
});

test('C (integration): the aspect-ratio step never widens a crop past an already-applied RIGHT layout constraint, even though reaching ratio 0.78 would want more width', async () => {
  const original = await makePassport381SizedImage();
  const faces = [{ boundingPoly: box(60, 776, 264, 1014), detectionConfidence: 0.98828125 }];
  const deps = buildDeps(faces);

  const layoutCropped = await extractApplicantPhotoCrop(original, 'image/jpeg', deps, REAL_381_TEXT_DETECTION_PAGES);
  assert.ok(layoutCropped);
  const meta = await sharp(layoutCropped!).metadata();

  // real columnX0=310, margin = max(8, 0.012*960) = 11.52 -> applied right
  // edge = 298.48; this face's clampedX0 is 0, so the crop's own width IS
  // its right edge in original-image pixels. Reaching ratio 0.78 against
  // this crop's height (412) would want width=321 -- the applied RIGHT
  // constraint must win instead.
  assert.equal(meta.width, 298, 'the applied RIGHT constraint (≈298.48) must survive the aspect-ratio step unchanged');
  assert.ok(meta.width! / meta.height! < 0.78, 'ratio 0.78 must NOT be fully reached here -- the hard RIGHT bound correctly takes priority over it');
});

test('D (integration): the column-detection search window stays the fixed, margin-independent one -- a close-by noise paragraph placed exactly in the gap between it and the (smaller) output-margin-derived window flips confidence HIGH->MEDIUM if the wrong window is used, proving the decoupling matters', () => {
  const faceBox = { x0: 60, y0: 776, x1: 264, y1: 1014 }; // real passport 381 face geometry
  const pageWidth = 960;
  const pageHeight = 1280;

  // A clean 6-member personal-data-column cluster (real 381 paragraph
  // geometry, see tests/visa.detectPersonalDataColumn.test.ts) -- none of
  // these members are affected by which window is used below (their own
  // mostlyInsideRegion overlap fraction stays under 50% either way).
  const cluster: LayoutParagraph[] = [
    { text: 'FAMILIYASI SURNAME', x0: 314, y0: 738, x1: 448, y1: 750 },
    { text: 'IBRAGIMOVA', x0: 317, y0: 753, x1: 477, y1: 773 },
    { text: "OTASINING ISMI FATHER'S NAME", x0: 312, y0: 823, x1: 511, y1: 838 },
    { text: 'BOTIROVNA', x0: 315, y0: 840, x1: 463, y1: 860 },
    { text: 'BERILGAN SANASH DATE OF ISSUE', x0: 311, y0: 1011, x1: 523, y1: 1049 },
    { text: 'AMAL QILISH MUDDATI DATE OF EXPIRY', x0: 310, y0: 1055, x1: 554, y1: 1094 },
  ];

  // A CONSTRUCTED (not real-passport) noise paragraph, placed deliberately
  // in the y-gap between the fixed context's range and what the smaller,
  // output-margin-derived window's range would have been: mostly inside
  // the former (correctly excluded as photo-area noise), entirely outside
  // the latter (incorrectly let through as a false column member).
  const noise: LayoutParagraph = { text: 'NOISE', x0: 342, y0: 1100, x1: 392, y1: 1160 };

  const fixedContext = buildColumnDetectionContext(faceBox);
  // What the search window used to be before this fix: the SAME side
  // margin, but the y-range tied to computeApplicantPhotoCropRegion.ts's
  // own TOP_MARGIN_FACTOR=0.4/BOTTOM_MARGIN_FACTOR=0.35 -- transcribed as
  // literals (not imported), matching this file's own convention of
  // writing out margin formulas rather than depending on another module's
  // private constants.
  const oldStyleOutputMarginContext = {
    x0: fixedContext.x0,
    x1: fixedContext.x1,
    y0: faceBox.y0 - (faceBox.y1 - faceBox.y0) * 0.4,
    y1: faceBox.y1 + (faceBox.y1 - faceBox.y0) * 0.35,
  };

  const withFixedContext = detectPersonalDataColumn([...cluster, noise], faceBox, fixedContext, pageWidth, pageHeight);
  const withOldStyleContext = detectPersonalDataColumn([...cluster, noise], faceBox, oldStyleOutputMarginContext, pageWidth, pageHeight);

  assert.ok(withFixedContext);
  assert.equal(withFixedContext!.confidence, 'HIGH', 'the fixed, margin-independent window correctly excludes the noise paragraph as photo-area text');
  assert.equal(withFixedContext!.memberCount, 6);

  assert.ok(withOldStyleContext);
  assert.equal(
    withOldStyleContext!.confidence,
    'MEDIUM',
    'the old, output-margin-tied window lets the noise paragraph through, dragging confidence below HIGH -- exactly the regression this decoupling fixes',
  );
  assert.equal(withOldStyleContext!.memberCount, 7);
});

test('D2 (true wiring, real pipeline): extractApplicantPhotoCrop actually threads buildColumnDetectionContext into detectPersonalDataColumn -- if the wiring were reverted to a baseRegion-tied window, this exact test would fail', async () => {
  // Same cluster+noise construction as D above (CONSTRUCTED noise
  // paragraph, not real-passport data), but routed through the REAL
  // extractApplicantPhotoCrop() -> buildLayoutConstraintsFromParagraphs()
  // -> detectPersonalDataColumn() call chain via textDetectionPages, not a
  // direct detectPersonalDataColumn() call. This is what D alone could not
  // prove: that the production wiring itself, not just the helper in
  // isolation, is what's actually used.
  const original = await makePassport381SizedImage();
  const faces = [{ boundingPoly: box(60, 776, 264, 1014), detectionConfidence: 0.98828125 }];
  const deps = buildDeps(faces);

  const pagesWithNoise: VisionPage[] = [
    {
      blocks: [
        {
          paragraphs: [
            paragraphFixture('FAMILIYASI SURNAME', 314, 738, 448, 750),
            paragraphFixture('IBRAGIMOVA', 317, 753, 477, 773),
            paragraphFixture("OTASINING ISMI FATHER'S NAME", 312, 823, 511, 838),
            paragraphFixture('BOTIROVNA', 315, 840, 463, 860),
            paragraphFixture('BERILGAN SANASH DATE OF ISSUE', 311, 1011, 523, 1049),
            paragraphFixture('AMAL QILISH MUDDATI DATE OF EXPIRY', 310, 1055, 554, 1094),
            // The same CONSTRUCTED noise paragraph as test D: mostly inside
            // the fixed (correct) search window, entirely outside what the
            // smaller output-margin-derived window's range would be.
            paragraphFixture('NOISE', 342, 1100, 392, 1160),
          ],
        },
      ],
    },
  ];

  const base = await extractApplicantPhotoCrop(original, 'image/jpeg', deps);
  const withNoisyCluster = await extractApplicantPhotoCrop(original, 'image/jpeg', deps, pagesWithNoise);

  assert.ok(base && withNoisyCluster);
  const baseMeta = await sharp(base!).metadata();
  const withMeta = await sharp(withNoisyCluster!).metadata();

  // With the correct (margin-independent) wiring, the noise paragraph is
  // excluded, confidence stays HIGH, and the RIGHT constraint narrows the
  // crop well below the face-only base (376px -> 298px, verified against
  // this exact fixture). If the wiring were ever reverted to a
  // baseRegion-tied window, the noise paragraph would drag confidence to
  // MEDIUM, the constraint would be rejected entirely, and this width
  // would equal baseMeta.width (376) instead -- making this assertion the
  // actual regression guard, not just a mechanism demonstration.
  assert.ok(
    withMeta.width! < baseMeta.width!,
    'the RIGHT constraint must still be applied through the real pipeline despite the noise paragraph -- if this fails, buildColumnDetectionContext is no longer wired in',
  );
  assert.equal(withMeta.width, 298, 'must match the known-correct constrained width for this fixture');
  assert.equal(baseMeta.width, 376, 'sanity check: the face-only base must be unaffected by the noise paragraph');
});

// --- MEDIUM-confidence columnResult, real pipeline wiring -----------------
// extractApplicantPhotoCrop.ts's buildLayoutConstraintsFromParagraphs now
// also supplies a RIGHT constraint when columnResult.confidence is
// 'MEDIUM' (same margin formula as HIGH -- see that function's own doc
// comment). This is a CONSTRUCTED (not real-passport) 4-member cluster,
// deliberately engineered so confidenceScore is capped by fieldCountScore
// alone (4 members -> fieldCountScore=min(1,4/8)=0.5) while dispersion
// (x0Range=10px) and the face gap (40px, within detectPersonalDataColumn's
// own [0.02,0.08]*pageWidth window) both stay perfect -- confirmed to
// produce confidence='MEDIUM' via detectPersonalDataColumn directly before
// this test was written. Deliberately has only 4 paragraphs (independently
// confirmed to leave detectDocumentBoundary's own result null for this
// fixture), so the narrowing this test checks for is attributable ONLY to
// the new MEDIUM column branch, not document-boundary clamping.
test('MEDIUM column (constructed, real pipeline): a 4-member cluster capped at MEDIUM by field count alone still narrows the crop through the real pipeline', async () => {
  const faceBox = { x0: 60, y0: 700, x1: 260, y1: 950 };
  const faces = [{ boundingPoly: box(faceBox.x0, faceBox.y0, faceBox.x1, faceBox.y1), detectionConfidence: 0.95 }];
  const deps = buildDeps(faces);
  const original = await sharp({
    create: { width: 960, height: 1280, channels: 3, background: { r: 230, g: 230, b: 230 } },
  })
    .jpeg()
    .toBuffer();

  const pages: VisionPage[] = [
    {
      blocks: [
        {
          paragraphs: [
            paragraphFixture('FAMILIYASI SURNAME', 305, 700, 480, 730),
            paragraphFixture("OTASINING ISMI FATHER'S NAME", 303, 740, 490, 770),
            paragraphFixture('FUQAROLIGI NATIONALITY', 300, 900, 470, 930),
            paragraphFixture("TUG'ILGAN SANASI DATE OF BIRTH", 310, 970, 500, 1000),
          ],
        },
      ],
    },
  ];

  const base = await extractApplicantPhotoCrop(original, 'image/jpeg', deps);
  const withMedium = await extractApplicantPhotoCrop(original, 'image/jpeg', deps, pages);
  assert.ok(base && withMedium);
  const baseMeta = await sharp(base!).metadata();
  const withMeta = await sharp(withMedium!).metadata();

  assert.equal(baseMeta.width, 370, 'sanity check: the face-only base for this fixture');
  assert.ok(
    withMeta.width! < baseMeta.width!,
    'the MEDIUM-confidence RIGHT constraint must narrow the crop through the real pipeline -- if this fails, the MEDIUM branch is not wired in',
  );
  assert.equal(withMeta.width, 288, 'must match the known-correct constrained width for this fixture');
});
