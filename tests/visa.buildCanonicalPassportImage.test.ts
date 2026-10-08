import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { buildCanonicalPassportImage } from '../src/visa/buildCanonicalPassportImage.js';
import type { VisionFaceAnnotation } from '../src/visa/computeApplicantPhotoCropRegion.js';
import type { VisionPage } from '../src/ocr/visual/extractIssueDateFromVisionStructure.js';

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

function paragraphFixture(text: string, x0: number, y0: number, x1: number, y1: number) {
  return {
    words: [{ symbols: [...text].map((ch) => ({ text: ch })) }],
    boundingBox: box(x0, y0, x1, y1),
  };
}

async function makeImage(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 220, g: 220, b: 220 } } })
    .jpeg()
    .toBuffer();
}

// --- safe, never-crashes behavior ---

test('buildCanonicalPassportImage returns the full EXIF-normalized image unchanged when textDetectionPages is omitted', async () => {
  const original = await makeImage(800, 1000);
  const result = await buildCanonicalPassportImage(original, []);

  assert.equal(result.boundary, null);
  assert.equal(result.width, 800);
  assert.equal(result.height, 1000);
});

test('buildCanonicalPassportImage returns the full normalized image unchanged when textDetectionPages is an empty array', async () => {
  const original = await makeImage(800, 1000);
  const result = await buildCanonicalPassportImage(original, [], []);

  assert.equal(result.boundary, null);
  assert.equal(result.width, 800);
  assert.equal(result.height, 1000);
});

test('buildCanonicalPassportImage never throws when textDetectionPages is malformed -- falls back to the full normalized image', async () => {
  const original = await makeImage(800, 1000);
  const malformedPages = [{ blocks: [{ paragraphs: 'not-an-array' as unknown as [] }] }] as unknown as VisionPage[];

  const result = await buildCanonicalPassportImage(original, [], malformedPages);

  assert.equal(result.boundary, null);
  const meta = await sharp(result.buffer).metadata();
  assert.equal(meta.width, 800);
  assert.equal(meta.height, 1000);
});

test('buildCanonicalPassportImage never throws for a completely undecodable buffer -- falls back to the untouched original bytes', async () => {
  const garbage = Buffer.from('not-a-real-image');

  const result = await buildCanonicalPassportImage(garbage, [], [{ blocks: [] }]);

  assert.equal(result.boundary, null);
  assert.equal(result.buffer.toString(), 'not-a-real-image', 'must fall back to the exact, untouched original buffer');
});

test('buildCanonicalPassportImage EXIF-normalizes the image even when no boundary crop is applied', async () => {
  // A 90°-rotated (EXIF orientation 6) image: raw pixel dimensions are
  // swapped relative to the normalized, correctly-oriented output.
  const rawPortrait = await sharp({ create: { width: 600, height: 900, channels: 3, background: { r: 200, g: 200, b: 200 } } })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();

  const result = await buildCanonicalPassportImage(rawPortrait, []);

  // After EXIF orientation 6 (rotate 90° CW) is applied, a 600x900 raw image
  // becomes 900x600 in normalized (displayed) space.
  assert.equal(result.width, 900);
  assert.equal(result.height, 600);
});

// --- the 4 required real-world framing scenarios (synthetic fixtures --
// see visa.extractApplicantPhotoCrop.test.ts's own note: no real production
// background/hand-held/tilted Telegram photos exist yet in this engagement) ---

test('canonical image: a passport-only photo (text/face spanning nearly the whole frame) is a complete no-op -- no unnecessary crop', async () => {
  const width = 960;
  const height = 1280;
  const original = await makeImage(width, height);
  const faces: VisionFaceAnnotation[] = [{ boundingPoly: box(151, 805, 322, 1004), detectionConfidence: 0.95 }];

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

  const result = await buildCanonicalPassportImage(original, faces, fullPageParagraphs);

  assert.equal(result.boundary, null, 'a passport that already fills the frame must be a no-op, not a tiny/guessed crop');
  assert.equal(result.width, width, 'no width should be lost when the passport already fills the frame');
  assert.equal(result.height, height, 'no height should be lost when the passport already fills the frame');
});

test('canonical image: a passport photographed with real surrounding background is isolated to ONLY the passport', async () => {
  const width = 1200;
  const height = 1600;
  const original = await makeImage(width, height);
  const faces: VisionFaceAnnotation[] = [{ boundingPoly: box(320, 950, 520, 1200), detectionConfidence: 0.95 }];

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

  const result = await buildCanonicalPassportImage(original, faces, backgroundPages);

  assert.ok(result.boundary, 'expected a confidently detected boundary for a real-background scenario');
  assert.ok(result.height < height, 'the canonical image must be shorter than the full frame, excluding background above the document');
  assert.ok(result.width < width, 'the canonical image must be narrower than the full frame');

  const meta = await sharp(result.buffer).metadata();
  assert.equal(meta.width, result.width);
  assert.equal(meta.height, result.height);
});

test('canonical image: a passport held in a hand is isolated from the hand/holder -- the holder\'s own face never expands the canonical crop', async () => {
  const width = 1000;
  const height = 1400;
  const original = await makeImage(width, height);
  // Hand-holder's own face: large, confident, far above the passport.
  const holderFace: VisionFaceAnnotation = { boundingPoly: box(500, 60, 900, 460), detectionConfidence: 0.97 };
  // The passport's own printed photo face.
  const passportFace: VisionFaceAnnotation = { boundingPoly: box(300, 850, 480, 1100), detectionConfidence: 0.9 };

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

  const withHolder = await buildCanonicalPassportImage(original, [holderFace, passportFace], handHeldPages);
  const withoutHolder = await buildCanonicalPassportImage(original, [passportFace], handHeldPages);

  assert.ok(withHolder.boundary, 'expected a confidently detected boundary');
  // The holder's face is excluded from the union either way (its center
  // fails the Y-axis proximity check on its own), so it never EXPANDS the
  // crop in either scenario. But once excluded, the holder's own box still
  // horizontally overlaps the margin zone on the right (holder x-range
  // 500-900 vs. content x1=760, raw margin-only x1=800) -- Formula A/C's
  // margin-tightening (see detectDocumentBoundary.ts) correctly pulls that
  // margin back to the content boundary on that side, so withHolder is
  // narrower than withoutHolder by design, not a regression.
  assert.equal(withHolder.width, 500, 'Formula A/C must tighten the right margin back to the content boundary (760) because the excluded holder face overlaps that margin zone');
  assert.equal(withoutHolder.width, 540, 'with no excluded face, the margin is the untightened content + 4% boundary');
  assert.equal(withHolder.height, withoutHolder.height, 'the holder face never overlaps the margin zone on the Y-axis, so Formula A/C leaves height untouched');
  // And the holder's face (y0=60) must fall OUTSIDE the detected boundary.
  assert.ok(withHolder.boundary!.y0 > 460, 'the boundary must not reach up into the holder\'s face region');
});

test('canonical image: a tilted/perspective-distorted passport is still isolated from background (region isolation, NOT perspective rectification)', async () => {
  const width = 1200;
  const height = 1600;
  const original = await makeImage(width, height);
  const faces: VisionFaceAnnotation[] = [{ boundingPoly: box(340, 1000, 520, 1230), detectionConfidence: 0.93 }];

  // Diagonally-drifting paragraph boxes, simulating Vision's own bounding
  // boxes for a tilted/skewed printed passport -- see
  // visa.extractApplicantPhotoCrop.test.ts's identical fixture and its own
  // note: this is region isolation only, never dewarping.
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

  const result = await buildCanonicalPassportImage(original, faces, tiltedPages);

  assert.ok(result.boundary, 'expected a confidently detected boundary even for a tilted cluster');
  assert.ok(result.height < height, 'the canonical image must still exclude background above/around a tilted document cluster');
  // The passport's own content (face + text) must never be lost: the
  // boundary must still contain both the face and every paragraph.
  assert.ok(result.boundary!.x0 <= 340 && result.boundary!.y0 <= 1000, 'the boundary must not cut into the face');
  assert.ok(result.boundary!.x1 >= 865 && result.boundary!.y1 >= 1230, 'the boundary must not cut into the printed text');
});
