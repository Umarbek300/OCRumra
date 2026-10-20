import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import {
  buildColumnDetectionContext,
  computeHardBounds,
  extractApplicantPhotoCrop,
  type ExtractApplicantPhotoCropDependencies,
} from '../src/visa/extractApplicantPhotoCrop.js';
import {
  applyTargetAspectRatio,
  computeApplicantPhotoCropRegion,
  selectBestFaceBox,
  type VisionFaceAnnotation,
} from '../src/visa/computeApplicantPhotoCropRegion.js';
import { detectPersonalDataColumn, type LayoutParagraph } from '../src/visa/detectPersonalDataColumn.js';
import {
  clampRegionToBoundary,
  detectDocumentBoundary,
  filterFacesToBoundary,
  filterParagraphsToBoundary,
} from '../src/visa/detectDocumentBoundary.js';
import { flattenParagraphsToNormalizedSpace } from '../src/visa/transformVisionCoordinates.js';
import { locateMrzParagraphGeometry } from '../src/ocr/mrz/locateMrzParagraphGeometry.js';
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

test('document boundary: a passport-only image (text/face spanning nearly the whole frame) leaves WIDTH untouched; HEIGHT is now additionally protected by the new BOTTOM-axis occupancy check', async () => {
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
  // WIDTH: document boundary detection itself (no HIGH-confidence
  // column/MRZ in this sparse fixture, and no documentBoundary is even
  // confidently formed here) does not shrink the crop below the pure
  // face-only size on this axis.
  assert.equal(boundaryMeta.width, faceOnlyMeta.width);
  // HEIGHT: this fixture's own 'MRZ LINE SIMULATED LONG TEXT ROW HERE'
  // paragraph (y0=1230-1260, x0=20-940, i.e. edge-to-edge) sits inside the
  // BOTTOM expansion gap between baseRegion's own bottom edge and the
  // image's own bottom edge, and overlaps the region's own x-range -- so
  // the new BOTTOM occupancy check in computeHardBounds now correctly caps
  // growth there, same as the pure face-only crop would. Verified by
  // actually running this exact fixture: boundaryMeta.height is 348 (==
  // baseRegion's own height, zero growth), vs faceOnlyMeta's 460. This is a
  // genuinely changed mechanism (this implementation adds BOTTOM-axis
  // protection; nothing before looked at this axis at all), not a hidden
  // failure -- the two no longer need to match.
  assert.equal(boundaryMeta.height, 348);
  assert.equal(faceOnlyMeta.height, 460);
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

// =============================================================================
// V CROP TEXT PROTECTION -- computeHardBounds's four-direction occupancy
// check (TOP/RIGHT/BOTTOM/LEFT). All fixtures below are synthetic, built
// from first principles to isolate each axis -- not derived from any real
// photo. Every number was obtained by actually running the real, exported
// functions (computeApplicantPhotoCropRegion, detectDocumentBoundary,
// filterFacesToBoundary, clampRegionToBoundary, computeHardBounds,
// applyTargetAspectRatio, and the full extractApplicantPhotoCrop pipeline),
// never hand-derived.
//
// Shared fixture convention: "filler" paragraphs are placed strictly INSIDE
// the face-only baseRegion's own x/y span, so they are provably inert for
// all four occupancy checks (each check only ever looks at the gap BEYOND
// baseRegion, never baseRegion's own interior) -- they exist only to reach
// detectDocumentBoundary's own MIN_PARAGRAPHS_FOR_BOUNDARY floor without
// contaminating which axis a given test isolates.
// =============================================================================

function hardBoundsFixtureImage(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 220, g: 220, b: 220 } } }).jpeg().toBuffer();
}

// Tall/narrow face (900x750 image): baseRegion works out to
// {left:68, top:0, width:315, height:690} -- its own width/height ratio
// sits well below 0.78, so applyTargetAspectRatio must grow WIDTH to
// approach the target, isolating the LEFT/RIGHT axes.
const HB_LR_FACE: VisionFaceAnnotation = { boundingPoly: box(150, 150, 300, 550), detectionConfidence: 0.95 };
const HB_LR_FILLERS = [
  paragraphFixture('FILLER A', 100, 50, 200, 70),
  paragraphFixture('FILLER B', 150, 600, 250, 620),
  paragraphFixture('FILLER C', 100, 650, 200, 670),
];

// Wide/short face (900x900 image): baseRegion works out to
// {left:0, top:90, width:770, height:263} -- ratio sits well above 0.78, so
// applyTargetAspectRatio must grow HEIGHT, isolating the TOP/BOTTOM axes.
const HB_TB_FACE: VisionFaceAnnotation = { boundingPoly: box(150, 150, 550, 300), detectionConfidence: 0.95 };
const HB_TB_FILLERS = [
  paragraphFixture('FILLER A', 100, 100, 200, 120),
  paragraphFixture('FILLER B', 300, 150, 400, 170),
  paragraphFixture('FILLER C', 500, 300, 600, 320),
];

test('V text protection -- RIGHT alone: a real paragraph in the RIGHT expansion gap caps hardRight at baseRegion.right, through the full pipeline', async () => {
  const width = 900, height = 750;
  const pages: VisionPage[] = [
    { blocks: [{ paragraphs: [paragraphFixture('RIGHT TEXT ROW', 500, 300, 750, 330), ...HB_LR_FILLERS] }] },
  ];
  const deps = buildDeps([HB_LR_FACE]);
  const original = await hardBoundsFixtureImage(width, height);
  const cropped = await extractApplicantPhotoCrop(original, 'image/jpeg', deps, pages);
  assert.ok(cropped);
  const meta = await sharp(cropped!).metadata();
  // Verified via the real pipeline: baseRegion.right=383; without this
  // protection, growth would reach into the RIGHT TEXT ROW (x0=500).
  assert.equal(meta.width, 319, 'known-correct width for this fixture -- the crop stops at baseRegion.right (383), confirmed below not to cross x0=500');
  assert.equal(meta.height, 670);
});

test('V text protection -- RIGHT alone (unit level): hardRight is capped at exactly baseRegion.right, not the looser document-boundary value', () => {
  const width = 900, height = 750;
  const paragraphs = [paragraphFixture('RIGHT TEXT ROW', 500, 300, 750, 330), ...HB_LR_FILLERS];
  const pages: VisionPage[] = [{ blocks: [{ paragraphs }] }];
  const normalizedParagraphs = flattenParagraphsToNormalizedSpace(pages, { rawWidth: width, rawHeight: height, orientation: undefined });
  const faces = [HB_LR_FACE];
  const documentBoundary = detectDocumentBoundary(normalizedParagraphs, faces, width, height);
  assert.ok(documentBoundary);
  const effectiveFaces = filterFacesToBoundary(faces, documentBoundary!);
  const baseRegion = computeApplicantPhotoCropRegion(effectiveFaces, width, height);
  assert.ok(baseRegion);
  assert.equal(baseRegion!.left + baseRegion!.width, 383, 'sanity check: baseRegion.right for this fixture');
  const faceBox = selectBestFaceBox(effectiveFaces);
  const region = clampRegionToBoundary(baseRegion!, documentBoundary!, faceBox!);

  const hardBounds = computeHardBounds(region, baseRegion!, width, height, documentBoundary, normalizedParagraphs);
  assert.equal(hardBounds.hardRight, 383, 'hardRight must be capped at baseRegion.right -- the real text occupies the gap');

  const final = applyTargetAspectRatio(region, 0.78, faceBox!, hardBounds.hardLeft, hardBounds.hardTop, hardBounds.hardRight, hardBounds.hardBottom);
  assert.ok(final.left + final.width <= 500, 'the final crop must stay clear of the RIGHT text row\'s own left edge (x0=500)');
});

test('V text protection -- LEFT alone: a real paragraph in the LEFT expansion gap caps hardLeft at baseRegion.left, through the full pipeline', async () => {
  const width = 900, height = 750;
  const pages: VisionPage[] = [
    { blocks: [{ paragraphs: [paragraphFixture('LEFT TEXT ROW', 10, 300, 60, 330), ...HB_LR_FILLERS] }] },
  ];
  const deps = buildDeps([HB_LR_FACE]);
  const original = await hardBoundsFixtureImage(width, height);
  const cropped = await extractApplicantPhotoCrop(original, 'image/jpeg', deps, pages);
  assert.ok(cropped);
  const meta = await sharp(cropped!).metadata();
  assert.equal(meta.width, 268, 'known-correct width -- the crop stops at baseRegion.left (68), confirmed below not to cross x1=60');
  assert.equal(meta.height, 670);
});

test('V text protection -- LEFT alone (unit level): hardLeft is capped at exactly baseRegion.left', () => {
  const width = 900, height = 750;
  const paragraphs = [paragraphFixture('LEFT TEXT ROW', 10, 300, 60, 330), ...HB_LR_FILLERS];
  const pages: VisionPage[] = [{ blocks: [{ paragraphs }] }];
  const normalizedParagraphs = flattenParagraphsToNormalizedSpace(pages, { rawWidth: width, rawHeight: height, orientation: undefined });
  const faces = [HB_LR_FACE];
  const documentBoundary = detectDocumentBoundary(normalizedParagraphs, faces, width, height);
  assert.ok(documentBoundary);
  const effectiveFaces = filterFacesToBoundary(faces, documentBoundary!);
  const baseRegion = computeApplicantPhotoCropRegion(effectiveFaces, width, height);
  assert.ok(baseRegion);
  assert.equal(baseRegion!.left, 68, 'sanity check: baseRegion.left for this fixture');
  const faceBox = selectBestFaceBox(effectiveFaces);
  const region = clampRegionToBoundary(baseRegion!, documentBoundary!, faceBox!);

  const hardBounds = computeHardBounds(region, baseRegion!, width, height, documentBoundary, normalizedParagraphs);
  assert.equal(hardBounds.hardLeft, 68, 'hardLeft must be capped at baseRegion.left');

  const final = applyTargetAspectRatio(region, 0.78, faceBox!, hardBounds.hardLeft, hardBounds.hardTop, hardBounds.hardRight, hardBounds.hardBottom);
  assert.ok(final.left >= 60, 'the final crop must stay clear of the LEFT text row\'s own right edge (x1=60)');
});

test('V text protection -- TOP alone: a real paragraph in the TOP expansion gap caps hardTop at baseRegion.top, through the full pipeline', async () => {
  const width = 900, height = 900;
  const pages: VisionPage[] = [
    { blocks: [{ paragraphs: [paragraphFixture('TOP TEXT ROW', 50, 20, 650, 50), ...HB_TB_FILLERS] }] },
  ];
  const deps = buildDeps([HB_TB_FACE]);
  const original = await hardBoundsFixtureImage(width, height);
  const cropped = await extractApplicantPhotoCrop(original, 'image/jpeg', deps, pages);
  assert.ok(cropped);
  const meta = await sharp(cropped!).metadata();
  assert.equal(meta.width, 672);
  assert.equal(meta.height, 266, 'known-correct height -- hardTop is capped at baseRegion.top (90), confirmed below not to cross y1=50');
});

test('V text protection -- TOP alone (unit level): hardTop is capped at exactly baseRegion.top', () => {
  const width = 900, height = 900;
  const paragraphs = [paragraphFixture('TOP TEXT ROW', 50, 20, 650, 50), ...HB_TB_FILLERS];
  const pages: VisionPage[] = [{ blocks: [{ paragraphs }] }];
  const normalizedParagraphs = flattenParagraphsToNormalizedSpace(pages, { rawWidth: width, rawHeight: height, orientation: undefined });
  const faces = [HB_TB_FACE];
  const documentBoundary = detectDocumentBoundary(normalizedParagraphs, faces, width, height);
  assert.ok(documentBoundary);
  const effectiveFaces = filterFacesToBoundary(faces, documentBoundary!);
  const baseRegion = computeApplicantPhotoCropRegion(effectiveFaces, width, height);
  assert.ok(baseRegion);
  assert.equal(baseRegion!.top, 90, 'sanity check: baseRegion.top for this fixture');
  const faceBox = selectBestFaceBox(effectiveFaces);
  const region = clampRegionToBoundary(baseRegion!, documentBoundary!, faceBox!);

  const hardBounds = computeHardBounds(region, baseRegion!, width, height, documentBoundary, normalizedParagraphs);
  assert.equal(hardBounds.hardTop, 90, 'hardTop must be capped at baseRegion.top');

  const final = applyTargetAspectRatio(region, 0.78, faceBox!, hardBounds.hardLeft, hardBounds.hardTop, hardBounds.hardRight, hardBounds.hardBottom);
  assert.ok(final.top >= 50, 'the final crop must stay clear of the TOP text row\'s own bottom edge (y1=50)');
});

test('V text protection -- BOTTOM alone: a real paragraph in the BOTTOM expansion gap caps hardBottom at baseRegion.bottom, through the full pipeline', async () => {
  const width = 900, height = 900;
  const pages: VisionPage[] = [
    { blocks: [{ paragraphs: [paragraphFixture('BOTTOM TEXT ROW', 50, 420, 650, 450), ...HB_TB_FILLERS] }] },
  ];
  const deps = buildDeps([HB_TB_FACE]);
  const original = await hardBoundsFixtureImage(width, height);
  const cropped = await extractApplicantPhotoCrop(original, 'image/jpeg', deps, pages);
  assert.ok(cropped);
  const meta = await sharp(cropped!).metadata();
  assert.equal(meta.width, 672);
  assert.equal(meta.height, 289, 'known-correct height -- hardBottom is capped at baseRegion.bottom (353), confirmed below not to cross y0=420');
});

test('V text protection -- BOTTOM alone (unit level): hardBottom is capped at exactly baseRegion.bottom', () => {
  const width = 900, height = 900;
  const paragraphs = [paragraphFixture('BOTTOM TEXT ROW', 50, 420, 650, 450), ...HB_TB_FILLERS];
  const pages: VisionPage[] = [{ blocks: [{ paragraphs }] }];
  const normalizedParagraphs = flattenParagraphsToNormalizedSpace(pages, { rawWidth: width, rawHeight: height, orientation: undefined });
  const faces = [HB_TB_FACE];
  const documentBoundary = detectDocumentBoundary(normalizedParagraphs, faces, width, height);
  assert.ok(documentBoundary);
  const effectiveFaces = filterFacesToBoundary(faces, documentBoundary!);
  const baseRegion = computeApplicantPhotoCropRegion(effectiveFaces, width, height);
  assert.ok(baseRegion);
  assert.equal(baseRegion!.top + baseRegion!.height, 353, 'sanity check: baseRegion.bottom for this fixture');
  const faceBox = selectBestFaceBox(effectiveFaces);
  const region = clampRegionToBoundary(baseRegion!, documentBoundary!, faceBox!);

  const hardBounds = computeHardBounds(region, baseRegion!, width, height, documentBoundary, normalizedParagraphs);
  assert.equal(hardBounds.hardBottom, 353, 'hardBottom must be capped at baseRegion.bottom');

  const final = applyTargetAspectRatio(region, 0.78, faceBox!, hardBounds.hardLeft, hardBounds.hardTop, hardBounds.hardRight, hardBounds.hardBottom);
  assert.ok(final.top + final.height <= 420, 'the final crop must stay clear of the BOTTOM text row\'s own top edge (y0=420)');
});

test('V text protection -- regression: an empty RIGHT expansion zone (no paragraph there) leaves hardRight completely uncapped, even though the zone genuinely extends past baseRegion.right', () => {
  const width = 900, height = 750;
  // FILLER D's own right edge (380) sits just inside baseRegion.right (383)
  // -- inert for the occupancy check -- but widens the pre-existing
  // document-boundary union just enough that hardRight (416) ends up
  // LOOSER than baseRegion.right (383), so the new check's own guard
  // (`hardRight > baseRegionRight`) is genuinely exercised here, not
  // skipped as a trivial no-op.
  const paragraphs = [
    paragraphFixture('FILLER A', 100, 50, 200, 70),
    paragraphFixture('FILLER B', 150, 600, 250, 620),
    paragraphFixture('FILLER C', 100, 650, 200, 670),
    paragraphFixture('FILLER D', 150, 100, 380, 120),
  ];
  const pages: VisionPage[] = [{ blocks: [{ paragraphs }] }];
  const normalizedParagraphs = flattenParagraphsToNormalizedSpace(pages, { rawWidth: width, rawHeight: height, orientation: undefined });
  const faces = [HB_LR_FACE];
  const documentBoundary = detectDocumentBoundary(normalizedParagraphs, faces, width, height);
  assert.ok(documentBoundary);
  const effectiveFaces = filterFacesToBoundary(faces, documentBoundary!);
  const baseRegion = computeApplicantPhotoCropRegion(effectiveFaces, width, height);
  assert.ok(baseRegion);
  const faceBox = selectBestFaceBox(effectiveFaces);
  const region = clampRegionToBoundary(baseRegion!, documentBoundary!, faceBox!);

  const hardBounds = computeHardBounds(region, baseRegion!, width, height, documentBoundary, normalizedParagraphs);
  assert.equal(hardBounds.hardRight, 416, 'no paragraph occupies the (baseRegion.right, hardRight) gap -- hardRight must stay at its pre-existing, looser value, unaffected by the new check');
});

test('V text protection -- precision: a paragraph that only TOUCHES baseRegion.right (zero actual overlap) must not trigger the RIGHT cap', () => {
  const width = 900, height = 750;
  // Ends exactly at baseRegion.right (383) -- strict '>' in the occupancy
  // check means touching the edge, with zero overlap into the gap, is
  // never mistaken for a real collision.
  const paragraphs = [paragraphFixture('TOUCH ONLY', 200, 300, 383, 330), ...HB_LR_FILLERS];
  const pages: VisionPage[] = [{ blocks: [{ paragraphs }] }];
  const normalizedParagraphs = flattenParagraphsToNormalizedSpace(pages, { rawWidth: width, rawHeight: height, orientation: undefined });
  const faces = [HB_LR_FACE];
  const documentBoundary = detectDocumentBoundary(normalizedParagraphs, faces, width, height);
  assert.ok(documentBoundary);
  const effectiveFaces = filterFacesToBoundary(faces, documentBoundary!);
  const baseRegion = computeApplicantPhotoCropRegion(effectiveFaces, width, height);
  assert.ok(baseRegion);
  assert.equal(baseRegion!.left + baseRegion!.width, 383, 'sanity check: the paragraph\'s own x1 exactly equals baseRegion.right');
  const faceBox = selectBestFaceBox(effectiveFaces);
  const region = clampRegionToBoundary(baseRegion!, documentBoundary!, faceBox!);

  const hardBounds = computeHardBounds(region, baseRegion!, width, height, documentBoundary, normalizedParagraphs);
  assert.equal(hardBounds.hardRight, 419, 'a paragraph that only touches baseRegion.right, with no actual overlap into the gap, must never trigger the cap');
});

test('V text protection -- LEFT+RIGHT both active simultaneously: real text on both sides caps both edges, growth stays exactly at baseRegion\'s own width, and the face remains fully contained', async () => {
  const width = 900, height = 750;
  const pages: VisionPage[] = [
    {
      blocks: [
        {
          paragraphs: [
            paragraphFixture('RIGHT TEXT ROW', 500, 300, 750, 330),
            paragraphFixture('LEFT TEXT ROW', 10, 300, 60, 330),
            ...HB_LR_FILLERS,
          ],
        },
      ],
    },
  ];
  const faces = [HB_LR_FACE];
  const deps = buildDeps(faces);
  const original = await hardBoundsFixtureImage(width, height);
  const cropped = await extractApplicantPhotoCrop(original, 'image/jpeg', deps, pages);
  assert.ok(cropped);
  const meta = await sharp(cropped!).metadata();
  // Verified via the real pipeline: both sides capped at baseRegion's own
  // edges (68 and 383) -- zero width growth at all, since baseRegion's own
  // width (315) already fills the entire [68,383] span.
  assert.equal(meta.width, 315, 'zero growth -- both LEFT and RIGHT are capped at baseRegion\'s own edges');
  assert.equal(meta.height, 670);

  // Confirm face containment directly against the known face box for this fixture.
  const normalizedParagraphs = flattenParagraphsToNormalizedSpace(pages, { rawWidth: width, rawHeight: height, orientation: undefined });
  const documentBoundary = detectDocumentBoundary(normalizedParagraphs, faces, width, height);
  const effectiveFaces = filterFacesToBoundary(faces, documentBoundary!);
  const baseRegion = computeApplicantPhotoCropRegion(effectiveFaces, width, height);
  const faceBox = selectBestFaceBox(effectiveFaces);
  const region = clampRegionToBoundary(baseRegion!, documentBoundary!, faceBox!);
  const hardBounds = computeHardBounds(region, baseRegion!, width, height, documentBoundary, normalizedParagraphs);
  const final = applyTargetAspectRatio(region, 0.78, faceBox!, hardBounds.hardLeft, hardBounds.hardTop, hardBounds.hardRight, hardBounds.hardBottom);
  assert.ok(
    faceBox!.x0 >= final.left && faceBox!.y0 >= final.top && faceBox!.x1 <= final.left + final.width && faceBox!.y1 <= final.top + final.height,
    'the detected face must remain fully inside the final crop',
  );
});

test('V text protection -- TOP+BOTTOM both active simultaneously: real text above and below caps both edges, growth stays exactly at baseRegion\'s own height', async () => {
  const width = 900, height = 900;
  const pages: VisionPage[] = [
    {
      blocks: [
        {
          paragraphs: [
            paragraphFixture('TOP TEXT ROW', 50, 20, 650, 50),
            paragraphFixture('BOTTOM TEXT ROW', 50, 420, 650, 450),
            ...HB_TB_FILLERS,
          ],
        },
      ],
    },
  ];
  const deps = buildDeps([HB_TB_FACE]);
  const original = await hardBoundsFixtureImage(width, height);
  const cropped = await extractApplicantPhotoCrop(original, 'image/jpeg', deps, pages);
  assert.ok(cropped);
  const meta = await sharp(cropped!).metadata();
  assert.equal(meta.width, 672);
  assert.equal(meta.height, 263, 'zero growth -- both TOP and BOTTOM are capped at baseRegion\'s own edges');
});

test('V text protection -- TOP+RIGHT active simultaneously on DIFFERENT axes: each axis is capped independently with no cross-interference, and neither paragraph enters the final crop', async () => {
  const width = 900, height = 900;
  const pages: VisionPage[] = [
    {
      blocks: [
        {
          paragraphs: [
            paragraphFixture('TOP TEXT ROW', 50, 20, 650, 50),
            paragraphFixture('RIGHT TEXT ROW', 800, 150, 890, 300),
            ...HB_TB_FILLERS,
          ],
        },
      ],
    },
  ];
  const faces = [HB_TB_FACE];
  const deps = buildDeps(faces);
  const original = await hardBoundsFixtureImage(width, height);
  const cropped = await extractApplicantPhotoCrop(original, 'image/jpeg', deps, pages);
  assert.ok(cropped);
  const meta = await sharp(cropped!).metadata();
  // Verified via the real pipeline: the HEIGHT axis is the one that grows
  // here (width stays at baseRegion's own 770, already capped by the RIGHT
  // check); height grows only slightly (263 -> 266), using up a small,
  // genuinely unprotected-but-empty margin below baseRegion.bottom --
  // still well clear of both paragraphs.
  assert.equal(meta.width, 756);
  assert.equal(meta.height, 266);

  const normalizedParagraphs = flattenParagraphsToNormalizedSpace(pages, { rawWidth: width, rawHeight: height, orientation: undefined });
  const documentBoundary = detectDocumentBoundary(normalizedParagraphs, faces, width, height);
  assert.ok(documentBoundary);
  const effectiveFaces = filterFacesToBoundary(faces, documentBoundary!);
  const baseRegion = computeApplicantPhotoCropRegion(effectiveFaces, width, height);
  assert.ok(baseRegion);
  const faceBox = selectBestFaceBox(effectiveFaces);
  const region = clampRegionToBoundary(baseRegion!, documentBoundary!, faceBox!);
  const hardBounds = computeHardBounds(region, baseRegion!, width, height, documentBoundary, normalizedParagraphs);
  assert.equal(hardBounds.hardTop, 90, 'TOP is capped at baseRegion.top');
  assert.equal(hardBounds.hardRight, 770, 'RIGHT is capped at baseRegion.right, independently of TOP');
});

test('V text protection -- crop never exceeds the image bounds, even when a face sits at the image corner with real text nearby', async () => {
  const width = 500, height = 600;
  const face: VisionFaceAnnotation = { boundingPoly: box(0, 0, 150, 180), detectionConfidence: 0.95 };
  const pages: VisionPage[] = [
    {
      blocks: [
        {
          paragraphs: [
            paragraphFixture('EDGE LABEL ROW NEAR CORNER', 0, 0, 200, 20),
            paragraphFixture('ANOTHER FIELD ROW', 0, 220, 300, 250),
            paragraphFixture('YET ANOTHER FIELD ROW HERE', 0, 280, 320, 310),
            paragraphFixture('AND ONE MORE FIELD ROW TOO', 0, 340, 330, 370),
          ],
        },
      ],
    },
  ];
  const deps = buildDeps([face]);
  const original = await hardBoundsFixtureImage(width, height);
  const cropped = await extractApplicantPhotoCrop(original, 'image/jpeg', deps, pages);
  assert.ok(cropped, 'a document-boundary union touching the image corner must never crash or produce a null crop');
  const meta = await sharp(cropped!).metadata();
  assert.ok(meta.width! > 0 && meta.width! <= width, 'crop width must stay within [0, imageWidth]');
  assert.ok(meta.height! > 0 && meta.height! <= height, 'crop height must stay within [0, imageHeight]');
});

test('V text protection -- expandDimension redirection mechanism (direct proof): capping hardRight alone, without the LEFT check, would redirect width growth all the way to hardLeft=0, crossing real LEFT-side text; the actual hardLeft=baseRegion.left cap (computed above) prevents this', () => {
  // Reuses the exact region/faceBox the LEFT+RIGHT simultaneous test above
  // produces for this fixture (region after document-boundary clamp:
  // {left:68, top:20, width:315, height:670}), to isolate expandDimension's
  // own "shift, not shrink" redirection from the rest of the pipeline.
  const region = { left: 68, top: 20, width: 315, height: 670 };
  const faceBox = { x0: 150, y0: 150, x1: 300, y1: 550 };

  // Counterfactual: hardRight capped at baseRegion.right (383), but hardLeft
  // left at its loose, pre-occupancy-check value (0) -- i.e. exactly what a
  // RIGHT-only fix (with no LEFT protection) would produce.
  const withoutLeftCheck = applyTargetAspectRatio(region, 0.78, faceBox, /* hardLeft */ 0, /* hardTop */ 20, /* hardRight */ 383, /* hardBottom */ 700);
  assert.equal(withoutLeftCheck.left, 0, 'without a LEFT check, the RIGHT cap\'s unused growth share shifts entirely onto the LEFT side, all the way out to hardLeft');
  assert.ok(withoutLeftCheck.left < 60, 'THE RISK: this redirected growth would cross the real LEFT text\'s own right edge (x1=60) -- exactly the exposure a RIGHT-only fix would introduce');

  // The actual fix: hardLeft correctly capped to baseRegion.left (68).
  const withLeftCheck = applyTargetAspectRatio(region, 0.78, faceBox, /* hardLeft */ 68, /* hardTop */ 20, /* hardRight */ 383, /* hardBottom */ 700);
  assert.equal(withLeftCheck.left, 68, 'with the LEFT check, growth cannot be redirected past baseRegion.left');
  assert.ok(withLeftCheck.left >= 60, 'the fixed result stays clear of the LEFT text\'s right edge (x1=60)');
});

test('V text protection -- expandDimension redirection mechanism (direct proof, TOP/BOTTOM axis): capping hardTop alone, without the BOTTOM check, would redirect height growth all the way to hardBottom=900, crossing real BOTTOM-side text; the actual hardBottom=baseRegion.bottom cap prevents this', () => {
  const region = { left: 14, top: 90, width: 756, height: 263 };
  const faceBox = { x0: 150, y0: 150, x1: 550, y1: 300 };

  const withoutBottomCheck = applyTargetAspectRatio(region, 0.78, faceBox, /* hardLeft */ 14, /* hardTop */ 90, /* hardRight */ 770, /* hardBottom */ 900);
  assert.equal(withoutBottomCheck.height, 810, 'without a BOTTOM check, height growth runs all the way down to hardBottom (900)');
  assert.ok(withoutBottomCheck.top + withoutBottomCheck.height > 420, 'THE RISK: this redirected growth would cross the real BOTTOM text\'s own top edge (y0=420)');

  const withBottomCheck = applyTargetAspectRatio(region, 0.78, faceBox, /* hardLeft */ 14, /* hardTop */ 90, /* hardRight */ 770, /* hardBottom */ 353);
  assert.equal(withBottomCheck.height, 263, 'with the BOTTOM check capped at baseRegion.bottom (353), there is zero room left to grow');
  assert.ok(withBottomCheck.top + withBottomCheck.height <= 420, 'the fixed result stays clear of the BOTTOM text\'s top edge (y0=420)');
});

// --- V text protection -- REAL PASSPORT 381 DATA -------------------------
// Reuses REAL_381_TEXT_DETECTION_PAGES / makePassport381SizedImage / the
// face box+confidence already defined above (verbatim real production
// Vision geometry for passport 381 -- see that fixture's own doc comment
// and tests/visa.detectPersonalDataColumn.test.ts for the same data at the
// unit level). Nothing here is synthetic or invented: every coordinate
// below (the 10 personal-data-column paragraph boxes + the 1 real MRZ
// paragraph box) is copied verbatim from REAL_381_TEXT_DETECTION_PAGES
// above. This does NOT prove photo quality on arbitrary real images in
// general (see the final report for that caveat) -- it proves that for
// THIS ONE already-studied real passport's actual geometry, the pipeline's
// face-containment and text-exclusion properties hold end to end, and that
// the new computeHardBounds occupancy checks are not merely a theoretical
// concern: this real passport's own MRZ paragraph genuinely sits in the
// BOTTOM growth gap and would otherwise re-enter the crop.
const REAL_381_PERSONAL_COLUMN_AND_MRZ_BOXES: Array<[number, number, number, number]> = [
  [314, 738, 448, 750], // FAMILIYASI SURNAME
  [317, 753, 477, 773], // IBRAGIMOVA
  [312, 823, 511, 838], // OTASINING ISMI FATHER'S NAME
  [315, 840, 463, 860], // BOTIROVNA
  [313, 867, 477, 882], // FUQAROLIGI NATIONALITY
  [312, 884, 447, 903], // UZBEKISTAN
  [312, 908, 528, 920], // TUG'ILGAN SANASI DATE OF BIRTH
  [316, 921, 478, 941], // 12 03 2018
  [311, 1011, 523, 1049], // BERILGAN SANASH DATE OF ISSUE 15 03 2024
  [310, 1055, 554, 1094], // AMAL QILISH MUDDATI DATE OF EXPIRY 14 03 2029
  [42, 1135, 821, 1222], // MRZ line
];

function boxIntersectsRegion(box: [number, number, number, number], region: { left: number; top: number; width: number; height: number }): boolean {
  const [x0, y0, x1, y1] = box;
  return x0 < region.left + region.width && x1 > region.left && y0 < region.top + region.height && y1 > region.top;
}

test('V text protection -- REAL PASSPORT 381: the layout-aware + computeHardBounds-protected crop fully contains the real face and excludes every real personal-data/MRZ paragraph', async () => {
  const width = 960, height = 1280;
  const original = await makePassport381SizedImage();
  const faces = [{ boundingPoly: box(60, 776, 264, 1014), detectionConfidence: 0.98828125 }];
  const deps = buildDeps(faces);

  // Full-pipeline cross-check: the real, public extractApplicantPhotoCrop
  // must actually produce this exact size -- the lower-level replica below
  // is only used to recover the {left,top} this public function does not
  // itself return, never as a parallel/divergent computation.
  const cropped = await extractApplicantPhotoCrop(original, 'image/jpeg', deps, REAL_381_TEXT_DETECTION_PAGES);
  assert.ok(cropped);
  const meta = await sharp(cropped!).metadata();

  const normalizedParagraphs = flattenParagraphsToNormalizedSpace(REAL_381_TEXT_DETECTION_PAGES, {
    rawWidth: width,
    rawHeight: height,
    orientation: undefined,
  });
  const documentBoundary = detectDocumentBoundary(normalizedParagraphs, faces, width, height);
  assert.ok(documentBoundary, 'sanity check: this real paragraph set forms a confident document boundary');
  const effectiveFaces = filterFacesToBoundary(faces, documentBoundary!);
  const baseRegion = computeApplicantPhotoCropRegion(effectiveFaces, width, height);
  assert.ok(baseRegion);
  const faceBox = selectBestFaceBox(effectiveFaces);
  assert.ok(faceBox);

  const paragraphsForLayout = filterParagraphsToBoundary(normalizedParagraphs, documentBoundary!);
  const mrzResult = locateMrzParagraphGeometry(paragraphsForLayout, width, height);
  assert.ok(mrzResult && mrzResult.confidence === 'HIGH', 'sanity check: the real MRZ paragraph is found at HIGH confidence');
  const expandedFaceRegion = buildColumnDetectionContext(faceBox!);
  const columnResult = detectPersonalDataColumn(paragraphsForLayout, faceBox!, expandedFaceRegion, width, height, [mrzResult!.paragraph]);
  assert.ok(columnResult && columnResult.confidence === 'HIGH', 'sanity check: the real personal-data column is found at HIGH confidence');

  // Mirrors buildLayoutConstraintsFromParagraphs's own margin formula in
  // extractApplicantPhotoCrop.ts (RIGHT_MARGIN_FRACTION / BOTTOM_MARGIN_FRACTION
  // = 0.012, MIN_MARGIN_PIXELS = 8) -- not a guessed value, copied from that
  // module's own (unexported) constants, read directly from its source.
  const rightMargin = Math.max(8, 0.012 * width);
  const bottomMargin = Math.max(8, 0.012 * height);
  const layoutConstraints = { right: columnResult!.columnX0 - rightMargin, bottom: mrzResult!.top - bottomMargin };
  const constrainedRegion = computeApplicantPhotoCropRegion(effectiveFaces, width, height, layoutConstraints);
  let region = constrainedRegion ?? baseRegion!;
  const { appliedRightConstraint, appliedBottomConstraint } = region;
  region = { ...clampRegionToBoundary(region, documentBoundary!, faceBox!), appliedRightConstraint, appliedBottomConstraint };

  const hardBounds = computeHardBounds(region, baseRegion!, width, height, documentBoundary, normalizedParagraphs);
  // The real MRZ paragraph (y0=1135..y1=1222) sits inside the BOTTOM growth
  // gap between baseRegion's own bottom (681+417=1098) and the
  // document-boundary-derived looser value -- the new BOTTOM occupancy
  // check must engage here, on real data, not just on constructed fixtures.
  assert.equal(hardBounds.hardBottom, baseRegion!.top + baseRegion!.height, 'the new BOTTOM occupancy check must cap growth at baseRegion.bottom for this real MRZ paragraph');

  const final = applyTargetAspectRatio(region, 0.78, faceBox!, hardBounds.hardLeft, hardBounds.hardTop, hardBounds.hardRight, hardBounds.hardBottom);

  // Cross-check against the real public pipeline's own output size.
  assert.equal(meta.width, final.width, 'the lower-level replica must match the real extractApplicantPhotoCrop output exactly');
  assert.equal(meta.height, final.height, 'the lower-level replica must match the real extractApplicantPhotoCrop output exactly');

  assert.ok(
    faceBox!.x0 >= final.left && faceBox!.y0 >= final.top && faceBox!.x1 <= final.left + final.width && faceBox!.y1 <= final.top + final.height,
    'the real detected face must remain fully inside the final crop',
  );
  assert.ok(final.left >= 0 && final.top >= 0 && final.left + final.width <= width && final.top + final.height <= height, 'the final crop must stay within the image bounds');

  for (const realTextBox of REAL_381_PERSONAL_COLUMN_AND_MRZ_BOXES) {
    assert.equal(
      boxIntersectsRegion(realTextBox, final),
      false,
      `real passport text box [${realTextBox.join(',')}] must not intersect the final crop`,
    );
  }
});

test('V text protection -- REAL PASSPORT 381 (before/after): without any layout/text awareness at all, the pure face-only crop WOULD have intruded into most of this real passport\'s own printed text -- demonstrating the real-world problem this fix addresses, not just an abstract geometric scenario', async () => {
  const width = 960, height = 1280;
  const original = await makePassport381SizedImage();
  const faces = [{ boundingPoly: box(60, 776, 264, 1014), detectionConfidence: 0.98828125 }];
  const deps = buildDeps(faces);

  // The pure face-only pipeline call (3-argument form, no textDetectionPages
  // at all) -- i.e. exactly how this function behaved before ANY of this
  // engagement's layout/document-boundary/text-protection work existed.
  const cropped = await extractApplicantPhotoCrop(original, 'image/jpeg', deps);
  assert.ok(cropped);
  const meta = await sharp(cropped!).metadata();

  const baseRegion = computeApplicantPhotoCropRegion(faces, width, height);
  assert.ok(baseRegion);
  const faceBox = selectBestFaceBox(faces);
  assert.ok(faceBox);
  const hardBounds = computeHardBounds(baseRegion!, baseRegion!, width, height, null, []);
  const final = applyTargetAspectRatio(baseRegion!, 0.78, faceBox!, hardBounds.hardLeft, hardBounds.hardTop, hardBounds.hardRight, hardBounds.hardBottom);

  assert.equal(meta.width, final.width, 'the lower-level replica must match the real extractApplicantPhotoCrop output exactly');
  assert.equal(meta.height, final.height, 'the lower-level replica must match the real extractApplicantPhotoCrop output exactly');

  const intrudedBoxes = REAL_381_PERSONAL_COLUMN_AND_MRZ_BOXES.filter((realTextBox) => boxIntersectsRegion(realTextBox, final));
  assert.ok(
    intrudedBoxes.length >= 8,
    `expected the pure face-only crop to intrude into most of the 11 real text boxes on this real passport (got ${intrudedBoxes.length}) -- this is the real-world exposure the layout-aware + computeHardBounds protection exists to close`,
  );
});

// --- V text protection -- REAL PASSPORT 414 (RIGHT-side growth protection) ---
// Coordinates (face box + all 16 paragraph boxes) are copied verbatim from
// tests/visa.detectPersonalDataColumn.test.ts's own "real passport 414"
// fixture (896x1280, the only real passport on record whose personal-data
// column reaches only MEDIUM confidence, x0Range=51px, includes genuine
// garbled OCR fragments) -- real production Vision geometry, not invented.
//
// detectionConfidence = 0.95 below is a PLACEHOLDER, NOT a transcribed real
// Vision value: that fixture's own file only records FaceBox (x0/y0/x1/y1),
// because detectPersonalDataColumn never needs a confidence number -- no
// real detectionConfidence for this face was ever written down anywhere in
// this engagement. 0.95 is the same placeholder convention this test file
// already uses for every other non-381 face fixture (e.g. the many
// `detectionConfidence: 0.95` literals above); it only needs to clear
// computeApplicantPhotoCropRegion.ts's MIN_DETECTION_CONFIDENCE=0.5 gate,
// which does not affect geometry. This placeholder means: this test proves
// the fix's behavior on real column/MRZ/face GEOMETRY, but does NOT prove
// anything about how a real Vision confidence score for this exact face
// would interact with the pipeline's own confidence-based branches.
const REAL_414_PARAGRAPHS: Array<[string, number, number, number, number]> = [
  ['buf-', 323, 310, 475, 405],
  ['SHAXSIY IMZO / HOLDERS SIGNATURE', 285, 567, 545, 593],
  ['UZB', 602, 439, 679, 466],
  ['DAVLAT KODI / COUNTRY CODE', 393, 660, 569, 683],
  ['UZB', 467, 684, 502, 698],
  ['PASPORT RAQAMI / PASSPORT No', 596, 650, 781, 670],
  ['FA7811218', 638, 672, 770, 696],
  ['TOSHMATOVA', 300, 731, 451, 760],
  ['BAKHROMOVNA', 307, 810, 472, 840],
  ['FUQAROLIGI / NATIONALITY UZBEKISTAN', 295, 833, 447, 877],
  ["TUG'ILGAN SANASI / DATE OF BIRTH", 312, 869, 460, 892],
  ['11 04 1964', 311, 885, 463, 914],
  ['TASHKENT', 440, 918, 561, 945],
  ['BERILGAN SANASI / DATE OF ISSUE', 336, 963, 498, 986],
  ['25 05 2023 AMAL QILISH MUDDATI', 307, 980, 533, 1053],
  ['MIA 26291', 584, 963, 723, 994],
];

test('V text protection -- REAL PASSPORT 414 (Variant G: two-sided feasibility window clamps the RIGHT narrowing UP into the safe gap instead of rejecting it outright, MEDIUM-confidence column, detectionConfidence is a documented PLACEHOLDER): the face stays fully contained and every one of the 16 real paragraphs is excluded, through the full real pipeline', async () => {
  const width = 896, height = 1280;
  const original = await sharp({ create: { width, height, channels: 3, background: { r: 230, g: 230, b: 230 } } }).jpeg().toBuffer();
  // PLACEHOLDER confidence -- see the module-level comment above. Face box
  // itself (88,784,266,991) is the real, recorded passport-414 geometry.
  const faces = [{ boundingPoly: box(88, 784, 266, 991), detectionConfidence: 0.95 }];
  const deps = buildDeps(faces);
  const pages: VisionPage[] = [{ blocks: [{ paragraphs: REAL_414_PARAGRAPHS.map(([t, x0, y0, x1, y1]) => paragraphFixture(t, x0, y0, x1, y1)) }] }];

  // Full-pipeline run through the REAL, Variant-G-fixed extractApplicantPhotoCrop.
  const baseCropped = await extractApplicantPhotoCrop(original, 'image/jpeg', deps);
  const layoutCropped = await extractApplicantPhotoCrop(original, 'image/jpeg', deps, pages);
  assert.ok(baseCropped && layoutCropped);
  const baseMeta = await sharp(baseCropped!).metadata();
  const layoutMeta = await sharp(layoutCropped!).metadata();
  // Verified via the real, fixed pipeline (not hand-derived): the face-only
  // base crop is still 364x467 (unchanged by this fix -- Variant G only
  // ever narrows, never widens, the face-only envelope); with this real
  // paragraph set, the layout-aware crop is now 275x362 -- narrower than
  // the pre-fix 312x400, because the RIGHT constraint (274.9) is now
  // accepted instead of rejected outright.
  assert.equal(baseMeta.width, 364);
  assert.equal(baseMeta.height, 467);
  assert.equal(layoutMeta.width, 275);
  assert.equal(layoutMeta.height, 362);

  // Lower-level replica, for the SAME reason and with the SAME independence
  // caveat as the passport-381 test above: this recovers {left,top}, which
  // the public function never returns, by replaying its own exported
  // building blocks -- it is a fidelity check against the real pipeline's
  // own output size, never an independent proof of correctness. It
  // deliberately mirrors buildLayoutConstraintsFromParagraphs's own NEW
  // Variant G formula (read directly from extractApplicantPhotoCrop.ts),
  // not the old single-value formula the pre-fix version of this test used.
  const normalizedParagraphs = flattenParagraphsToNormalizedSpace(pages, { rawWidth: width, rawHeight: height, orientation: undefined });
  const documentBoundary = detectDocumentBoundary(normalizedParagraphs, faces, width, height);
  assert.ok(documentBoundary);
  const effectiveFaces = filterFacesToBoundary(faces, documentBoundary!);
  const baseRegion = computeApplicantPhotoCropRegion(effectiveFaces, width, height);
  assert.ok(baseRegion);
  const faceBox = selectBestFaceBox(effectiveFaces);
  assert.ok(faceBox);

  const paragraphsForLayout = filterParagraphsToBoundary(normalizedParagraphs, documentBoundary!);
  const mrzResult = locateMrzParagraphGeometry(paragraphsForLayout, width, height);
  // This real fixture contains no MRZ-shaped line at all -- confirmed null,
  // so the BOTTOM constraint path is never exercised by this test; it
  // isolates to the RIGHT/column side, as required.
  assert.equal(mrzResult, null);
  const expandedFaceRegion = buildColumnDetectionContext(faceBox!);
  const columnResult = detectPersonalDataColumn(paragraphsForLayout, faceBox!, expandedFaceRegion, width, height, []);
  assert.ok(columnResult);
  assert.equal(columnResult!.confidence, 'MEDIUM', 'sanity check: this is the real MEDIUM-confidence passport-414 column, not HIGH');
  assert.equal(columnResult!.columnX0, 285, 'sanity check: real, recorded columnX0 for this passport');

  const rightMargin = Math.max(8, 0.012 * width);
  const candidateRight = columnResult!.columnX0 - rightMargin;
  const faceWidth = faceBox!.x1 - faceBox!.x0;
  const minFaceRightPadding = Math.max(8, 0.05 * faceWidth);
  const minSafeRight = faceBox!.x1 + minFaceRightPadding;
  const textCeiling = columnResult!.columnX0 - 8; // MIN_MARGIN_PIXELS, read from extractApplicantPhotoCrop.ts
  assert.equal(Math.round(candidateRight * 1000) / 1000, 274.248, 'sanity check: the OLD single-value candidate, pre-Variant-G');
  assert.equal(minSafeRight, 274.9, 'sanity check: the face-safety floor');
  assert.equal(textCeiling, 277, 'sanity check: the text-safety ceiling');
  assert.ok(minSafeRight <= textCeiling, 'sanity check: for this real passport the feasibility window is non-empty');
  const layoutConstraints = { right: Math.max(minSafeRight, candidateRight) };
  assert.equal(layoutConstraints.right, 274.9, 'sanity check: Variant G clamps UP to the face-safety floor, not the old (too-low) candidate');

  const constrainedRegion = computeApplicantPhotoCropRegion(effectiveFaces, width, height, layoutConstraints);
  // THE CORE BEHAVIOR CHANGE THIS TEST PROVES: unlike before this fix, the
  // RIGHT constraint IS now accepted by computeApplicantPhotoCropRegion's
  // own narrowing guard (274.9 >= box.x1+minFaceRightPadding=274.9, and
  // 274.9 < clampedX1), so `region` is the real constrained region, never
  // the face-only baseRegion fallback.
  assert.ok(constrainedRegion, 'the RIGHT constraint must now be accepted, not rejected');
  let region = constrainedRegion!;
  assert.equal(region.appliedRightConstraint, 274.9);
  const { appliedRightConstraint, appliedBottomConstraint } = region;
  region = { ...clampRegionToBoundary(region, documentBoundary!, faceBox!), appliedRightConstraint, appliedBottomConstraint };

  const hardBounds = computeHardBounds(region, baseRegion!, width, height, documentBoundary, normalizedParagraphs);
  // THE ACTUAL THING THIS TEST PROVES: hardRight is now capped at the real,
  // accepted appliedRightConstraint (274.9) -- not at the much looser
  // baseRegion.right (364) the pre-fix version of this test observed.
  assert.equal(hardBounds.hardRight, 274.9, 'hardRight must be capped at the accepted RIGHT constraint, not the looser baseRegion.right');

  const final = applyTargetAspectRatio(region, 0.78, faceBox!, hardBounds.hardLeft, hardBounds.hardTop, hardBounds.hardRight, hardBounds.hardBottom);
  assert.equal(layoutMeta.width, final.width, 'the lower-level replica must match the real extractApplicantPhotoCrop output exactly');
  assert.equal(layoutMeta.height, final.height, 'the lower-level replica must match the real extractApplicantPhotoCrop output exactly');

  assert.ok(final.left + final.width <= 275, 'the final crop must not grow past the accepted RIGHT constraint on this axis');
  assert.ok(
    faceBox!.x0 >= final.left && faceBox!.y0 >= final.top && faceBox!.x1 <= final.left + final.width && faceBox!.y1 <= final.top + final.height,
    'the real detected face must remain fully inside the final crop',
  );

  // THE FIX'S WHOLE POINT, now verified against every one of the 16 real
  // paragraphs (not merely the subset that used to sit in the growth gap):
  // with the RIGHT constraint now actually accepted and honored, NONE of
  // this real passport's printed text intrudes into the final crop. Before
  // this fix, this same assertion (inverted) was a documented, accepted
  // limitation -- this is the genuine, root-cause fix, not a weakened
  // assertion papering over the same behavior.
  const intrudingRealParagraphs = REAL_414_PARAGRAPHS.filter(([, x0, y0, x1, y1]) => boxIntersectsRegion([x0, y0, x1, y1], final));
  assert.deepEqual(
    intrudingRealParagraphs,
    [],
    `expected zero real paragraphs to intrude the final crop, got: ${intrudingRealParagraphs.map((p) => p[0]).join(', ')}`,
  );
});

// --- Variant G counter-examples -- PURELY SYNTHETIC fixtures (no real Vision
// data of any kind, geometry or confidence), deliberately constructed to
// exercise the two edge branches real passport data on record (381/408/409/
// 410/414) never reaches: an infeasible feasibility window, and no column
// detected at all. Face box (40x100) and paragraph geometry are hand-picked
// purely to control detectPersonalDataColumn's own scoring formula
// (dispersionScore/faceGapScore/fieldCountScore, read directly from
// detectPersonalDataColumn.ts) -- not representative of any real passport
// layout.
test('V text protection -- Variant G SYNTHETIC counter-example: face-text gap too tight for any single RIGHT value to protect both -- the feasibility window is empty, so the existing safe face-only fallback must be preserved, not a guessed narrower value', async () => {
  const width = 300, height = 1000;
  // faceWidth=40, faceHeight=100 (not a real passport proportion -- chosen
  // only to keep the expanded face-only crop above MIN_CROP_DIMENSION_PIXELS
  // while keeping minFaceRightPadding floored at the fixed 8px minimum).
  const faces = [{ boundingPoly: box(100, 300, 140, 400), detectionConfidence: 0.95 }];
  const deps = buildDeps(faces);
  // 4 synthetic paragraphs, columnX0=154 -- gap=14px past faceBox.x1=140.
  // Verified via this engagement's own scratchpad simulation against the
  // real, unmodified detectPersonalDataColumn: this gap is wide enough to
  // clear its "mostly inside the expanded face region" candidate filter
  // (20% area overlap, well under its 50% exclusion threshold) AND lands
  // inside its GAP_MIN/MAX_FRACTION ideal-gap band, so confidence reaches
  // real MEDIUM (fieldCountScore=0.5, dispersionScore=1, faceGapScore=1) --
  // not LOW, so this genuinely exercises buildLayoutConstraintsFromParagraphs's
  // HIGH-or-MEDIUM branch, not the separate confidence-gate fallback below.
  const paragraphs: Array<[string, number, number, number, number]> = [
    ['SYNTH1', 154, 300, 194, 330],
    ['SYNTH2', 154, 450, 194, 480],
    ['SYNTH3', 154, 600, 194, 630],
    ['SYNTH4', 154, 750, 194, 780],
  ];
  const pages: VisionPage[] = [{ blocks: [{ paragraphs: paragraphs.map(([t, x0, y0, x1, y1]) => paragraphFixture(t, x0, y0, x1, y1)) }] }];
  const original = await sharp({ create: { width, height, channels: 3, background: { r: 230, g: 230, b: 230 } } }).jpeg().toBuffer();

  const baseCropped = await extractApplicantPhotoCrop(original, 'image/jpeg', deps);
  const layoutCropped = await extractApplicantPhotoCrop(original, 'image/jpeg', deps, pages);
  assert.ok(baseCropped && layoutCropped);
  const baseMeta = await sharp(baseCropped!).metadata();
  const layoutMeta = await sharp(layoutCropped!).metadata();

  // Independently confirm the feasibility window really is empty for this
  // fixture (minSafeRight=148 > textCeiling=146), i.e. this test exercises
  // the REJECT branch, not accidentally the ACCEPT branch.
  const faceBox = selectBestFaceBox(faces)!;
  const normalizedParagraphs = flattenParagraphsToNormalizedSpace(pages, { rawWidth: width, rawHeight: height, orientation: undefined });
  const expandedFaceRegion = buildColumnDetectionContext(faceBox);
  const columnResult = detectPersonalDataColumn(normalizedParagraphs, faceBox, expandedFaceRegion, width, height, []);
  assert.ok(columnResult, 'sanity check: a column must actually be detected here (not the separate null-column case below)');
  assert.equal(columnResult!.confidence, 'MEDIUM', 'sanity check: real MEDIUM confidence, not LOW -- this must exercise Variant G, not the confidence gate');
  const minFaceRightPadding = Math.max(8, 0.05 * (faceBox.x1 - faceBox.x0));
  const minSafeRight = faceBox.x1 + minFaceRightPadding;
  const textCeiling = columnResult!.columnX0 - 8;
  assert.equal(minSafeRight, 148);
  assert.equal(textCeiling, 146);
  assert.ok(minSafeRight > textCeiling, 'sanity check: the feasibility window must be empty for this fixture');

  // THE ACTUAL BEHAVIOR THIS TEST PROVES: with the window empty, Variant G
  // must leave constraints.right unset entirely -- the layout-aware crop
  // must be byte-identical to the pure face-only crop, exactly as it was
  // before Variant G existed. A narrower, guessed value here would risk
  // clamping into either the face or the (synthetic) text column.
  assert.equal(layoutMeta.width, baseMeta.width, 'an infeasible window must fall back to the unchanged face-only crop width');
  assert.equal(layoutMeta.height, baseMeta.height, 'an infeasible window must fall back to the unchanged face-only crop height');
});

test('V text protection -- Variant G SYNTHETIC counter-example: no personal-data column detected at all (fewer than MIN_FIELD_COUNT candidates) -- the existing face-only fallback must be completely unchanged by Variant G', async () => {
  const width = 300, height = 1000;
  const faces = [{ boundingPoly: box(100, 300, 200, 400), detectionConfidence: 0.95 }];
  const deps = buildDeps(faces);
  // Only 2 candidate paragraphs -- below detectPersonalDataColumn's own
  // MIN_FIELD_COUNT=4, so it returns null (not LOW) for this fixture.
  const paragraphs: Array<[string, number, number, number, number]> = [
    ['SYNTH1', 260, 300, 290, 330],
    ['SYNTH2', 260, 450, 290, 480],
  ];
  const pages: VisionPage[] = [{ blocks: [{ paragraphs: paragraphs.map(([t, x0, y0, x1, y1]) => paragraphFixture(t, x0, y0, x1, y1)) }] }];
  const original = await sharp({ create: { width, height, channels: 3, background: { r: 230, g: 230, b: 230 } } }).jpeg().toBuffer();

  const baseCropped = await extractApplicantPhotoCrop(original, 'image/jpeg', deps);
  const layoutCropped = await extractApplicantPhotoCrop(original, 'image/jpeg', deps, pages);
  assert.ok(baseCropped && layoutCropped);
  const baseMeta = await sharp(baseCropped!).metadata();
  const layoutMeta = await sharp(layoutCropped!).metadata();

  const faceBox = selectBestFaceBox(faces)!;
  const normalizedParagraphs = flattenParagraphsToNormalizedSpace(pages, { rawWidth: width, rawHeight: height, orientation: undefined });
  const expandedFaceRegion = buildColumnDetectionContext(faceBox);
  const columnResult = detectPersonalDataColumn(normalizedParagraphs, faceBox, expandedFaceRegion, width, height, []);
  assert.equal(columnResult, null, 'sanity check: this fixture must produce no column result at all');

  assert.equal(layoutMeta.width, baseMeta.width, 'no detected column must fall back to the unchanged face-only crop width');
  assert.equal(layoutMeta.height, baseMeta.height, 'no detected column must fall back to the unchanged face-only crop height');
});

// --- V text protection -- REAL PASSPORTS 408, 409, 410 (regression baseline) ---
// Coordinates (face box + all paragraph boxes) are copied verbatim from
// tests/visa.detectPersonalDataColumn.test.ts's own "real passport 408/409/410"
// fixtures (960x1280 each, all three real HIGH-confidence columns). Real
// production Vision geometry, not invented.
//
// detectionConfidence = 0.95 for all three below is a PLACEHOLDER, NOT a
// transcribed real Vision value -- same documented limitation as the
// passport-414 test above: that fixture file never records a real
// confidence number for these faces. It only needs to clear
// MIN_DETECTION_CONFIDENCE=0.5, which does not affect geometry.
//
// IMPORTANT FINDING from running these three real fixtures through the
// real pipeline, NOW FIXED (see ROUNDING_EPSILON_PIXELS in
// extractApplicantPhotoCrop.ts's computeHardBounds): unlike passport 414
// (where the RIGHT narrowing constraint was REJECTED outright by
// computeApplicantPhotoCropRegion's own minFaceRightPadding gate -- a
// separate, still-open issue, deliberately NOT addressed here), for
// 408/409/410 the narrowing IS accepted by computeApplicantPhotoCropRegion.
// The true root cause (traced precisely by reading that function's own
// narrowing "attempts" loop): it rounds `left` and `width` INDEPENDENTLY
// via two separate Math.round() calls (unlike applyTargetAspectRatio's own
// final rounding, which deliberately rounds EDGES first to avoid exactly
// this), so for 408 and 410 both roundings drifted in the same direction,
// leaving `region.left + region.width` ~0.52px above the (non-integer)
// appliedRightConstraint value computeApplicantPhotoCropRegion itself had
// just computed and accepted as safe. Before the fix, computeHardBounds's
// guard (`region.left + region.width <= region.appliedRightConstraint`)
// failed by that sub-pixel amount and silently stopped treating the
// already-applied narrowing as a hard bound at all, so hardRight fell back
// to the much looser baseRegion-relative occupancy check, and
// applyTargetAspectRatio's growth step re-expanded the crop back past the
// real narrowed boundary, reintroducing real personal-data text that
// narrowing had successfully excluded moments earlier. Passport 409 was
// the one case among these three where the post-clamp arithmetic happened
// to land exactly at-or-under the constraint even before the fix, so its
// guard already held and no text re-entered there. ROUNDING_EPSILON_PIXELS=1
// (sized as the sum of two independent 0.5px Math.round tolerances -- the
// exact, provable worst case this two-independent-roundings mechanism can
// produce) now makes computeHardBounds correctly honor the already-vetted
// narrowing for 408 and 410 too, confirmed below by direct assertion on
// hardRight and by re-checking every real paragraph box against the final
// crop. This is a DIFFERENT, independent mechanism from 414's
// baseRegion-footprint limitation, which this fix does NOT touch.
const REAL_408_PARAGRAPHS: Array<[string, number, number, number, number]> = [
  ['SHAXSIY IMZO / HOLDERS SIGNATURE', 346, 581, 622, 603],
  ['UZB', 676, 445, 761, 472],
  ['FB1836885', 822, 109, 896, 564],
  ['DAVLAT KODI / COUNTRY CODE', 462, 678, 648, 700],
  ['PASPORT RAQAMI / PASSPORT No', 678, 665, 888, 688],
  ['FB1836885', 715, 693, 855, 718],
  ['FAMILIYASI / SURNAME', 350, 737, 480, 756],
  ['NODIROV', 355, 756, 467, 779],
  ['AVAZKHON', 358, 795, 484, 819],
  ["OTASINING ISMI / FATHER'S NAME", 354, 819, 545, 839],
  ['BOSITKHON UGLI', 360, 832, 581, 862],
  ['FUQAROLIGI / NATIONALITY', 358, 861, 515, 879],
  ['UZBEKISTAN', 359, 878, 487, 898],
  ["TUG'ILGAN SANASI / DATE OF BIRTH", 359, 896, 564, 914],
  ['06 08 1990', 366, 912, 520, 935],
  ["TUG'ILGAN JOYI / PLACE OF BIRTH", 485, 926, 681, 969],
  ['BERILGAN SANASI / DATE OF ISSUE', 366, 990, 563, 1008],
  ['08 11 2025', 372, 1007, 526, 1029],
  ['AMAL QILISH MUDDATI / DATE OF EXPIRY', 369, 1027, 597, 1044],
  ['07 11 2035', 376, 1045, 529, 1067],
  ['KIM TOMONIDAN BERILGAN / AUTHORITY', 636, 982, 870, 1000],
  ['PSC 60001', 648, 1001, 789, 1023],
];

const REAL_409_PARAGRAPHS: Array<[string, number, number, number, number]> = [
  ['SHAXSIY IMZO / HOLDERS SIGNATURE', 364, 598, 654, 615],
  ['UZB', 720, 463, 813, 491],
  ['DAVLAT KODI / COUNTRY CODE', 482, 705, 676, 722],
  ['UZB', 564, 730, 601, 742],
  ['PASPORT RAQAMI / PASSPORT No', 707, 697, 918, 715],
  ['FB1836966', 744, 722, 884, 746],
  ["OTASINING ISMI / FATHER'S NAME", 363, 844, 563, 865],
  ["TUG'ILGAN SANASI / DATE OF BIRTH", 366, 919, 576, 939],
  ['14 12 1965', 373, 934, 533, 959],
  ["TUG'ILGAN JOYI / PLACE OF BIRTH", 494, 949, 690, 968],
  ['TASHKENT', 508, 966, 634, 989],
  ['BERILGAN SANASI / DATE OF ISSUE', 369, 1007, 570, 1028],
  ['08 11 2025', 376, 1024, 533, 1048],
  ['AMAL QILISH MUDDATI / DATE OF EXPIRY', 370, 1041, 601, 1083],
  ['2035', 471, 1060, 534, 1078],
  ['KIM TOMONIDAN BERILGAN / AUTHORITY', 642, 995, 867, 1038],
];

const REAL_410_PARAGRAPHS: Array<[string, number, number, number, number]> = [
  ['SHAXSIY IMZO / HOLDERS SIGNATURE', 355, 598, 623, 617],
  ['UZB', 685, 466, 767, 493],
  ['DAVLAT KODI / COUNTRY CODE', 464, 699, 648, 715],
  ['UZB', 540, 722, 574, 734],
  ['PASEORT RAQAMI / PASSPORT No', 675, 690, 884, 708],
  ['FB1836969', 713, 717, 851, 740],
  ['FAMILIYASI SURNAME', 355, 753, 481, 768],
  ['ABDUVALIEVA', 361, 768, 529, 790],
  ["OTASINING ISMI FATHER'S NAME", 359, 832, 543, 847],
  ['RASHIDOVNA', 365, 849, 516, 868],
  ['FUQAROLIGI / NATIONALITY', 362, 872, 512, 886],
  ['UZBEKISTAN', 363, 889, 487, 903],
  ["TUG'ILGAN SANASI / DATE OF BIRTH", 363, 905, 560, 919],
  ['13 07 1969', 371, 920, 518, 937],
  ["TUG'ILGAN JOYI / PLACE OF BIRTH", 484, 939, 672, 951],
  ['TASHKENT', 497, 956, 616, 974],
  ['BERILGAN SANASI / DATE OF ISSUE', 370, 993, 559, 1006],
  ['08 11 2025', 377, 1009, 522, 1027],
  ['AMAL QILISH MUDDATI / DATE OF EXPIRY', 371, 1026, 591, 1062],
  ['KIM TOMONIDAN BERILGAN / AUTHORITY', 629, 997, 857, 1006],
  ['PSC 60001', 640, 1015, 778, 1031],
];

test('V text protection -- REAL PASSPORT 408 (RIGHT narrowing accepted AND now honored through growth, after the ROUNDING_EPSILON_PIXELS fix): the previously-observed sub-pixel rounding mismatch in the appliedRightConstraint carry-through no longer lets growth re-admit real surname/father-name text, through the full real pipeline', async () => {
  const width = 960, height = 1280;
  const original = await sharp({ create: { width, height, channels: 3, background: { r: 230, g: 230, b: 230 } } }).jpeg().toBuffer();
  const faces = [{ boundingPoly: box(135, 770, 312, 975), detectionConfidence: 0.95 }];
  const deps = buildDeps(faces);
  const pages: VisionPage[] = [{ blocks: [{ paragraphs: REAL_408_PARAGRAPHS.map(([t, x0, y0, x1, y1]) => paragraphFixture(t, x0, y0, x1, y1)) }] }];

  const baseCropped = await extractApplicantPhotoCrop(original, 'image/jpeg', deps);
  const layoutCropped = await extractApplicantPhotoCrop(original, 'image/jpeg', deps, pages);
  assert.ok(baseCropped && layoutCropped);
  const baseMeta = await sharp(baseCropped!).metadata();
  const layoutMeta = await sharp(layoutCropped!).metadata();
  // Verified via the real, now-fixed pipeline. layoutMeta.width changed
  // from 281 (pre-fix, buggy) to 280 (post-fix) -- a 1px-scale correction,
  // not a visible behavior regression.
  assert.equal(baseMeta.width, 372);
  assert.equal(baseMeta.height, 477);
  assert.equal(layoutMeta.width, 280);
  assert.equal(layoutMeta.height, 359);

  const normalizedParagraphs = flattenParagraphsToNormalizedSpace(pages, { rawWidth: width, rawHeight: height, orientation: undefined });
  const documentBoundary = detectDocumentBoundary(normalizedParagraphs, faces, width, height);
  assert.ok(documentBoundary);
  const effectiveFaces = filterFacesToBoundary(faces, documentBoundary!);
  const baseRegion = computeApplicantPhotoCropRegion(effectiveFaces, width, height);
  assert.ok(baseRegion);
  const faceBox = selectBestFaceBox(effectiveFaces);
  assert.ok(faceBox);

  const paragraphsForLayout = filterParagraphsToBoundary(normalizedParagraphs, documentBoundary!);
  const mrzResult = locateMrzParagraphGeometry(paragraphsForLayout, width, height);
  assert.equal(mrzResult, null);
  const expandedFaceRegion = buildColumnDetectionContext(faceBox!);
  const columnResult = detectPersonalDataColumn(paragraphsForLayout, faceBox!, expandedFaceRegion, width, height, []);
  assert.ok(columnResult);
  assert.equal(columnResult!.confidence, 'HIGH');
  assert.equal(columnResult!.columnX0, 346);

  const rightMargin = Math.max(8, 0.012 * width);
  const layoutConstraints = { right: columnResult!.columnX0 - rightMargin };
  const constrainedRegion = computeApplicantPhotoCropRegion(effectiveFaces, width, height, layoutConstraints);
  assert.ok(constrainedRegion, 'sanity check: unlike passport 414, this real narrowing IS accepted');
  let region = constrainedRegion!;
  const { appliedRightConstraint, appliedBottomConstraint } = region;
  assert.ok(appliedRightConstraint !== undefined);
  region = { ...clampRegionToBoundary(region, documentBoundary!, faceBox!), appliedRightConstraint, appliedBottomConstraint };
  // THE ROUNDING MISMATCH still exists at this exact point (unchanged by
  // the fix, which acts one step later in computeHardBounds): after the
  // boundary clamp, region's own right edge still technically exceeds
  // appliedRightConstraint by under 1px.
  assert.ok(
    region.left + region.width > appliedRightConstraint!,
    `expected the post-clamp region (right edge ${region.left + region.width}) to exceed appliedRightConstraint (${appliedRightConstraint}) by a sub-pixel amount -- this is the mechanism the fix tolerates`,
  );
  assert.ok(
    region.left + region.width - appliedRightConstraint! < 1,
    'sanity check: the mismatch is under 1px, exactly what ROUNDING_EPSILON_PIXELS=1 is sized to cover',
  );

  const hardBounds = computeHardBounds(region, baseRegion!, width, height, documentBoundary, normalizedParagraphs);
  // THE FIX, verified directly: hardRight now stays at the real applied
  // narrowing (appliedRightConstraint), NOT the looser baseRegion-relative
  // fallback -- the ROUNDING_EPSILON_PIXELS tolerance in computeHardBounds
  // now correctly honors this already-accepted constraint.
  assert.equal(hardBounds.hardRight, appliedRightConstraint, 'hardRight must now stay at the real applied narrowing, not fall back to baseRegion.right');

  const final = applyTargetAspectRatio(region, 0.78, faceBox!, hardBounds.hardLeft, hardBounds.hardTop, hardBounds.hardRight, hardBounds.hardBottom);
  assert.equal(layoutMeta.width, final.width, 'the lower-level replica must match the real extractApplicantPhotoCrop output exactly');
  assert.equal(layoutMeta.height, final.height, 'the lower-level replica must match the real extractApplicantPhotoCrop output exactly');

  assert.ok(
    faceBox!.x0 >= final.left && faceBox!.y0 >= final.top && faceBox!.x1 <= final.left + final.width && faceBox!.y1 <= final.top + final.height,
    'the real detected face must remain fully inside the final crop',
  );

  // THE FIXED CONSEQUENCE: real surname/father-name text no longer
  // re-enters the final crop. Not hidden, not asserted away -- checked
  // against every real paragraph box for this passport.
  const stillIntrudingRealParagraphs = REAL_408_PARAGRAPHS.filter(([, x0, y0, x1, y1]) => boxIntersectsRegion([x0, y0, x1, y1], final));
  assert.equal(
    stillIntrudingRealParagraphs.length,
    0,
    `expected zero intrusion for passport 408 after the fix (got ${stillIntrudingRealParagraphs.length} intruding paragraphs)`,
  );
});

test('V text protection -- REAL PASSPORT 409 (RIGHT narrowing accepted AND honored): the clean baseline case where the post-clamp region exactly satisfies appliedRightConstraint, through the full real pipeline', async () => {
  const width = 960, height = 1280;
  const original = await sharp({ create: { width, height, channels: 3, background: { r: 230, g: 230, b: 230 } } }).jpeg().toBuffer();
  const faces = [{ boundingPoly: box(115, 809, 332, 1061), detectionConfidence: 0.95 }];
  const deps = buildDeps(faces);
  const pages: VisionPage[] = [{ blocks: [{ paragraphs: REAL_409_PARAGRAPHS.map(([t, x0, y0, x1, y1]) => paragraphFixture(t, x0, y0, x1, y1)) }] }];

  const baseCropped = await extractApplicantPhotoCrop(original, 'image/jpeg', deps);
  const layoutCropped = await extractApplicantPhotoCrop(original, 'image/jpeg', deps, pages);
  assert.ok(baseCropped && layoutCropped);
  const baseMeta = await sharp(baseCropped!).metadata();
  const layoutMeta = await sharp(layoutCropped!).metadata();
  assert.equal(baseMeta.width, 451);
  assert.equal(baseMeta.height, 578);
  assert.equal(layoutMeta.width, 333);
  assert.equal(layoutMeta.height, 427);

  const normalizedParagraphs = flattenParagraphsToNormalizedSpace(pages, { rawWidth: width, rawHeight: height, orientation: undefined });
  const documentBoundary = detectDocumentBoundary(normalizedParagraphs, faces, width, height);
  assert.ok(documentBoundary);
  const effectiveFaces = filterFacesToBoundary(faces, documentBoundary!);
  const baseRegion = computeApplicantPhotoCropRegion(effectiveFaces, width, height);
  assert.ok(baseRegion);
  const faceBox = selectBestFaceBox(effectiveFaces);
  assert.ok(faceBox);

  const paragraphsForLayout = filterParagraphsToBoundary(normalizedParagraphs, documentBoundary!);
  const mrzResult = locateMrzParagraphGeometry(paragraphsForLayout, width, height);
  assert.equal(mrzResult, null);
  const expandedFaceRegion = buildColumnDetectionContext(faceBox!);
  const columnResult = detectPersonalDataColumn(paragraphsForLayout, faceBox!, expandedFaceRegion, width, height, []);
  assert.ok(columnResult);
  assert.equal(columnResult!.confidence, 'HIGH');
  assert.equal(columnResult!.columnX0, 363);

  const rightMargin = Math.max(8, 0.012 * width);
  const layoutConstraints = { right: columnResult!.columnX0 - rightMargin };
  const constrainedRegion = computeApplicantPhotoCropRegion(effectiveFaces, width, height, layoutConstraints);
  assert.ok(constrainedRegion);
  let region = constrainedRegion!;
  const { appliedRightConstraint, appliedBottomConstraint } = region;
  assert.ok(appliedRightConstraint !== undefined);
  region = { ...clampRegionToBoundary(region, documentBoundary!, faceBox!), appliedRightConstraint, appliedBottomConstraint };
  // THE DIFFERENCE FROM 408/410: here the post-clamp region's right edge
  // does NOT exceed appliedRightConstraint, so the guard holds.
  assert.ok(
    region.left + region.width <= appliedRightConstraint!,
    `expected the post-clamp region (right edge ${region.left + region.width}) to still satisfy appliedRightConstraint (${appliedRightConstraint}) for this real fixture`,
  );

  const hardBounds = computeHardBounds(region, baseRegion!, width, height, documentBoundary, normalizedParagraphs);
  assert.equal(hardBounds.hardRight, appliedRightConstraint, 'hardRight correctly stays at the real applied narrowing for this case');

  const final = applyTargetAspectRatio(region, 0.78, faceBox!, hardBounds.hardLeft, hardBounds.hardTop, hardBounds.hardRight, hardBounds.hardBottom);
  assert.equal(layoutMeta.width, final.width, 'the lower-level replica must match the real extractApplicantPhotoCrop output exactly');
  assert.equal(layoutMeta.height, final.height, 'the lower-level replica must match the real extractApplicantPhotoCrop output exactly');

  assert.ok(
    faceBox!.x0 >= final.left && faceBox!.y0 >= final.top && faceBox!.x1 <= final.left + final.width && faceBox!.y1 <= final.top + final.height,
    'the real detected face must remain fully inside the final crop',
  );

  // THE CLEAN RESULT: no real text re-enters for this passport.
  const stillIntrudingRealParagraphs = REAL_409_PARAGRAPHS.filter(([, x0, y0, x1, y1]) => boxIntersectsRegion([x0, y0, x1, y1], final));
  assert.equal(
    stillIntrudingRealParagraphs.length,
    0,
    `expected zero intrusion for passport 409 (got ${stillIntrudingRealParagraphs.length}) -- this is the one case among 408/409/410 where the rounding mismatch does not occur`,
  );
});

test('V text protection -- REAL PASSPORT 410 (RIGHT narrowing accepted AND now honored through growth, after the ROUNDING_EPSILON_PIXELS fix): the same rounding mismatch as passport 408 no longer lets real surname/DOB/nationality text re-enter, through the full real pipeline', async () => {
  const width = 960, height = 1280;
  const original = await sharp({ create: { width, height, channels: 3, background: { r: 230, g: 230, b: 230 } } }).jpeg().toBuffer();
  const faces = [{ boundingPoly: box(151, 805, 322, 1004), detectionConfidence: 0.95 }];
  const deps = buildDeps(faces);
  const pages: VisionPage[] = [{ blocks: [{ paragraphs: REAL_410_PARAGRAPHS.map(([t, x0, y0, x1, y1]) => paragraphFixture(t, x0, y0, x1, y1)) }] }];

  const baseCropped = await extractApplicantPhotoCrop(original, 'image/jpeg', deps);
  const layoutCropped = await extractApplicantPhotoCrop(original, 'image/jpeg', deps, pages);
  assert.ok(baseCropped && layoutCropped);
  const baseMeta = await sharp(baseCropped!).metadata();
  const layoutMeta = await sharp(layoutCropped!).metadata();
  // Verified via the real, now-fixed pipeline. layoutMeta.width changed
  // from 272 (pre-fix, buggy) to 271 (post-fix) -- a 1px-scale correction.
  assert.equal(baseMeta.width, 359);
  assert.equal(baseMeta.height, 460);
  assert.equal(layoutMeta.width, 271);
  assert.equal(layoutMeta.height, 348);

  const normalizedParagraphs = flattenParagraphsToNormalizedSpace(pages, { rawWidth: width, rawHeight: height, orientation: undefined });
  const documentBoundary = detectDocumentBoundary(normalizedParagraphs, faces, width, height);
  assert.ok(documentBoundary);
  const effectiveFaces = filterFacesToBoundary(faces, documentBoundary!);
  const baseRegion = computeApplicantPhotoCropRegion(effectiveFaces, width, height);
  assert.ok(baseRegion);
  const faceBox = selectBestFaceBox(effectiveFaces);
  assert.ok(faceBox);

  const paragraphsForLayout = filterParagraphsToBoundary(normalizedParagraphs, documentBoundary!);
  const mrzResult = locateMrzParagraphGeometry(paragraphsForLayout, width, height);
  assert.equal(mrzResult, null);
  const expandedFaceRegion = buildColumnDetectionContext(faceBox!);
  const columnResult = detectPersonalDataColumn(paragraphsForLayout, faceBox!, expandedFaceRegion, width, height, []);
  assert.ok(columnResult);
  assert.equal(columnResult!.confidence, 'HIGH');
  assert.equal(columnResult!.columnX0, 355);

  const rightMargin = Math.max(8, 0.012 * width);
  const layoutConstraints = { right: columnResult!.columnX0 - rightMargin };
  const constrainedRegion = computeApplicantPhotoCropRegion(effectiveFaces, width, height, layoutConstraints);
  assert.ok(constrainedRegion, 'sanity check: unlike passport 414, this real narrowing IS accepted');
  let region = constrainedRegion!;
  const { appliedRightConstraint, appliedBottomConstraint } = region;
  assert.ok(appliedRightConstraint !== undefined);
  region = { ...clampRegionToBoundary(region, documentBoundary!, faceBox!), appliedRightConstraint, appliedBottomConstraint };
  // THE ROUNDING MISMATCH still exists at this exact point (unchanged by
  // the fix, which acts one step later in computeHardBounds).
  assert.ok(
    region.left + region.width > appliedRightConstraint!,
    `expected the post-clamp region (right edge ${region.left + region.width}) to exceed appliedRightConstraint (${appliedRightConstraint}) by a sub-pixel amount -- this is the mechanism the fix tolerates`,
  );
  assert.ok(
    region.left + region.width - appliedRightConstraint! < 1,
    'sanity check: the mismatch is under 1px, exactly what ROUNDING_EPSILON_PIXELS=1 is sized to cover',
  );

  const hardBounds = computeHardBounds(region, baseRegion!, width, height, documentBoundary, normalizedParagraphs);
  // THE FIX, verified directly: hardRight now stays at the real applied
  // narrowing, not the looser baseRegion-relative fallback.
  assert.equal(hardBounds.hardRight, appliedRightConstraint, 'hardRight must now stay at the real applied narrowing, not fall back to baseRegion.right');

  const final = applyTargetAspectRatio(region, 0.78, faceBox!, hardBounds.hardLeft, hardBounds.hardTop, hardBounds.hardRight, hardBounds.hardBottom);
  assert.equal(layoutMeta.width, final.width, 'the lower-level replica must match the real extractApplicantPhotoCrop output exactly');
  assert.equal(layoutMeta.height, final.height, 'the lower-level replica must match the real extractApplicantPhotoCrop output exactly');

  assert.ok(
    faceBox!.x0 >= final.left && faceBox!.y0 >= final.top && faceBox!.x1 <= final.left + final.width && faceBox!.y1 <= final.top + final.height,
    'the real detected face must remain fully inside the final crop',
  );

  const stillIntrudingRealParagraphs = REAL_410_PARAGRAPHS.filter(([, x0, y0, x1, y1]) => boxIntersectsRegion([x0, y0, x1, y1], final));
  assert.equal(
    stillIntrudingRealParagraphs.length,
    0,
    `expected zero intrusion for passport 410 after the fix (got ${stillIntrudingRealParagraphs.length} intruding paragraphs)`,
  );
});
