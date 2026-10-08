import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clampRegionToBoundary,
  detectDocumentBoundary,
  filterFacesToBoundary,
  filterParagraphsToBoundary,
  type BoundaryParagraph,
  type FaceBox,
  type LooseFaceAnnotation,
} from '../src/visa/detectDocumentBoundary.js';

function paragraph(text: string, x0: number, y0: number, x1: number, y1: number): BoundaryParagraph {
  return { text, x0, y0, x1, y1 };
}

function face(x0: number, y0: number, x1: number, y1: number, confidence = 0.95): LooseFaceAnnotation {
  return {
    boundingPoly: {
      vertices: [
        { x: x0, y: y0 },
        { x: x1, y: y0 },
        { x: x1, y: y1 },
        { x: x0, y: y1 },
      ],
    },
    detectionConfidence: confidence,
  };
}

// --- detectDocumentBoundary ---

test('detectDocumentBoundary returns null when fewer than MIN_FIELD_COUNT-equivalent paragraphs exist (too little signal to trust)', () => {
  const paragraphs = [paragraph('A', 100, 100, 150, 120), paragraph('B', 100, 140, 150, 160)];
  const result = detectDocumentBoundary(paragraphs, [], 1000, 1000);
  assert.equal(result, null);
});

test('detectDocumentBoundary returns null when the passport already fills the frame (coverage >= 92%, nothing to exclude)', () => {
  // Paragraphs spread across nearly the entire 1000x1000 image.
  const paragraphs = [
    paragraph('A', 20, 20, 200, 60),
    paragraph('B', 800, 30, 980, 70),
    paragraph('C', 20, 900, 200, 970),
    paragraph('D', 800, 900, 980, 970),
    paragraph('E', 400, 500, 600, 540),
  ];
  const result = detectDocumentBoundary(paragraphs, [], 1000, 1000);
  assert.equal(result, null, 'a passport that already fills the frame must be treated as a no-op, not a tiny crop');
});

test('detectDocumentBoundary returns null when the resulting union is implausibly small (likely a detection artifact)', () => {
  const paragraphs = [
    paragraph('A', 500, 500, 520, 510),
    paragraph('B', 500, 515, 520, 525),
    paragraph('C', 500, 530, 520, 540),
    paragraph('D', 500, 545, 520, 555),
  ];
  const result = detectDocumentBoundary(paragraphs, [], 1000, 1000);
  assert.equal(result, null, 'a tiny cluster far below MIN_MEANINGFUL_COVERAGE must be distrusted, not treated as a confident tiny document');
});

test('detectDocumentBoundary detects a real background scenario: passport text clustered in the lower-center of a larger photo', () => {
  // Simulates a passport photographed on a table with visible background
  // above and to the sides -- text/face cluster in the lower-center ~50%
  // of a 1200x1600 frame.
  const paragraphs = [
    paragraph('FAMILIYASI', 300, 900, 500, 930),
    paragraph('SURNAME', 300, 935, 500, 960),
    paragraph('ISMI', 300, 970, 480, 995),
    paragraph('GIVEN NAMES', 300, 1000, 500, 1025),
    paragraph('OTASINING ISMI', 300, 1040, 550, 1065),
    paragraph('12 03 1990', 300, 1100, 460, 1125),
    paragraph('P<UZBTESTPERSON', 150, 1450, 1050, 1490),
  ];
  const faces: LooseFaceAnnotation[] = [face(150, 850, 350, 1100)];

  const result = detectDocumentBoundary(paragraphs, faces, 1200, 1600);

  assert.ok(result, 'expected a non-null boundary for a real background scenario');
  // Boundary must exclude the top ~53% of the frame (pure background) and the sides beyond the text/face cluster.
  assert.ok(result!.y0 > 700, 'boundary top must exclude the background above the passport');
  assert.ok(result!.x1 < 1200, 'boundary must not just be the full frame');
  assert.ok(result!.coverageFraction < 0.92);
  assert.ok(result!.coverageFraction >= 0.12);
});

test('detectDocumentBoundary expands the union to include a face positioned near (immediately adjacent to) the text cluster -- matching real passport layout, where the photo sits right beside the personal-data column', () => {
  const paragraphs = [
    paragraph('AA', 400, 400, 600, 430),
    paragraph('BB', 400, 440, 600, 470),
    paragraph('CC', 400, 480, 600, 510),
    paragraph('DD', 400, 520, 600, 550),
  ];
  // Face positioned immediately to the left of the text cluster, outside
  // its bbox but close enough (its right edge touches the text's own
  // left edge) to be treated as part of the same document.
  const faces: LooseFaceAnnotation[] = [face(200, 400, 400, 600)];

  const result = detectDocumentBoundary(paragraphs, faces, 1000, 1000);

  assert.ok(result);
  assert.ok(result!.x0 <= 200, 'boundary must expand left to include the nearby face, not just the text cluster');
});

test('detectDocumentBoundary does NOT expand the union for a face far from the text cluster (e.g. a hand-holder\'s own face elsewhere in frame)', () => {
  const paragraphs = [
    paragraph('AA', 250, 800, 750, 850),
    paragraph('BB', 250, 950, 750, 1000),
    paragraph('CC', 250, 1100, 750, 1150),
    paragraph('DD', 250, 1250, 750, 1300),
  ];
  // Face far above the text cluster -- outside the proximity margin.
  const faces: LooseFaceAnnotation[] = [face(600, 50, 900, 350)];

  const result = detectDocumentBoundary(paragraphs, faces, 1200, 1600);

  assert.ok(result);
  assert.ok(result!.y0 > 500, 'boundary must NOT stretch up to include a face far from the text cluster');
});

test('detectDocumentBoundary reports HIGH confidence for a rich cluster (>=8 paragraphs, >=30% coverage)', () => {
  const paragraphs = Array.from({ length: 9 }, (_, i) =>
    paragraph(`field${i}`, 200, 200 + i * 60, 700, 240 + i * 60),
  );
  const result = detectDocumentBoundary(paragraphs, [], 1000, 1000);
  assert.ok(result);
  assert.equal(result!.confidence, 'HIGH');
});

test('detectDocumentBoundary reports MEDIUM confidence for a sparser cluster', () => {
  // Union (250,300)-(750,630), ~24% coverage after margin on a 1000x1000
  // image -- comfortably above MIN_MEANINGFUL_COVERAGE, but only 4
  // paragraphs (< HIGH_CONFIDENCE_MIN_PARAGRAPHS=8), so MEDIUM applies
  // regardless of coverage.
  const paragraphs = [
    paragraph('AA', 250, 300, 750, 330),
    paragraph('BB', 250, 400, 750, 430),
    paragraph('CC', 250, 500, 750, 530),
    paragraph('DD', 250, 600, 750, 630),
  ];
  const result = detectDocumentBoundary(paragraphs, [], 1000, 1000);
  assert.ok(result);
  assert.equal(result!.confidence, 'MEDIUM');
});

test('detectDocumentBoundary returns null for zero/negative image dimensions', () => {
  const paragraphs = [paragraph('A', 10, 10, 20, 20), paragraph('B', 10, 30, 20, 40), paragraph('C', 10, 50, 20, 60), paragraph('D', 10, 70, 20, 80)];
  assert.equal(detectDocumentBoundary(paragraphs, [], 0, 1000), null);
  assert.equal(detectDocumentBoundary(paragraphs, [], 1000, 0), null);
});

// --- filterParagraphsToBoundary ---

test('filterParagraphsToBoundary keeps only paragraphs whose center falls inside the boundary', () => {
  const boundary: FaceBox = { x0: 100, y0: 100, x1: 500, y1: 500 };
  const paragraphs = [
    paragraph('inside', 200, 200, 300, 250),
    paragraph('outside', 600, 600, 700, 650),
    paragraph('center-just-outside', 450, 450, 650, 500), // center x=(450+650)/2=550 > boundary.x1=500
  ];
  const result = filterParagraphsToBoundary(paragraphs, boundary);
  const texts = result.map((p) => p.text);
  assert.deepEqual(texts, ['inside']);
});

// --- filterFacesToBoundary ---

test('filterFacesToBoundary keeps only faces whose center falls inside the boundary', () => {
  const boundary: FaceBox = { x0: 100, y0: 100, x1: 500, y1: 500 };
  const insideFace = face(200, 200, 300, 300);
  const outsideFace = face(600, 600, 700, 700);
  const result = filterFacesToBoundary([insideFace, outsideFace], boundary);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0], insideFace);
});

test('filterFacesToBoundary never returns an empty list -- falls back to the original unfiltered list when filtering would remove everything', () => {
  const boundary: FaceBox = { x0: 100, y0: 100, x1: 200, y1: 200 };
  const faceOutsideBoundary = face(600, 600, 700, 700);
  const result = filterFacesToBoundary([faceOutsideBoundary], boundary);
  assert.equal(result.length, 1, 'must fall back to the original list rather than returning zero candidates');
  assert.deepEqual(result[0], faceOutsideBoundary);
});

test('filterFacesToBoundary excludes a hand-holder\'s own (larger) face outside the document boundary, keeping only the passport photo\'s face', () => {
  const boundary: FaceBox = { x0: 300, y0: 900, x1: 1050, y1: 1550 }; // the detected passport region
  const passportPhotoFace = face(320, 950, 520, 1200); // center (420, 1075) -- inside the boundary
  const handHolderFace = face(700, 100, 1100, 700); // center (900, 400) -- well above the passport, much larger
  const result = filterFacesToBoundary([handHolderFace, passportPhotoFace], boundary);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0], passportPhotoFace);
});

// --- clampRegionToBoundary ---

test('clampRegionToBoundary shrinks a region that extends beyond the boundary', () => {
  const region = { left: 0, top: 0, width: 500, height: 500 };
  const boundary: FaceBox = { x0: 50, y0: 50, x1: 400, y1: 400 };
  const face: FaceBox = { x0: 150, y0: 150, x1: 250, y1: 250 };
  const result = clampRegionToBoundary(region, boundary, face);
  assert.equal(result.left, 50);
  assert.equal(result.top, 50);
  assert.ok(result.width < region.width);
  assert.ok(result.height < region.height);
});

test('clampRegionToBoundary never grows a region beyond its original extent', () => {
  const region = { left: 100, top: 100, width: 200, height: 200 };
  const boundary: FaceBox = { x0: 0, y0: 0, x1: 1000, y1: 1000 }; // much larger than the region
  const face: FaceBox = { x0: 150, y0: 150, x1: 250, y1: 250 };
  const result = clampRegionToBoundary(region, boundary, face);
  assert.deepEqual(result, region);
});

test('clampRegionToBoundary rejects the clamp (returns the original region) when it would cut into the face', () => {
  const region = { left: 0, top: 0, width: 500, height: 500 };
  const boundary: FaceBox = { x0: 0, y0: 0, x1: 200, y1: 500 }; // would cut right through the face below
  const face: FaceBox = { x0: 250, y0: 100, x1: 350, y1: 200 };
  const result = clampRegionToBoundary(region, boundary, face);
  assert.deepEqual(result, region, 'clamping must never be allowed to cut off part of the face');
});

test('clampRegionToBoundary rejects the clamp when the result would fall below the minimum crop dimension', () => {
  const region = { left: 0, top: 0, width: 500, height: 500 };
  const boundary: FaceBox = { x0: 0, y0: 0, x1: 50, y1: 50 }; // far too small
  const face: FaceBox = { x0: 10, y0: 10, x1: 30, y1: 30 };
  const result = clampRegionToBoundary(region, boundary, face);
  assert.deepEqual(result, region, 'an undersized clamp must be rejected, not silently applied');
});
