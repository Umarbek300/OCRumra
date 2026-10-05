import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeApplicantPhotoCropRegion, type VisionFaceAnnotation } from '../src/visa/computeApplicantPhotoCropRegion.js';

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

function face(
  boundingBox: ReturnType<typeof box> | null,
  detectionConfidence: number | null = 0.9,
): VisionFaceAnnotation {
  return { boundingPoly: boundingBox, detectionConfidence };
}

test('computeApplicantPhotoCropRegion returns null when there are no faces at all', () => {
  const region = computeApplicantPhotoCropRegion([], 1000, 1000);
  assert.equal(region, null);
});

test('computeApplicantPhotoCropRegion expands a centrally-placed, high-confidence face into a larger rectangle', () => {
  // A 100x100 face centered in a large 1000x1000 image, well away from any edge.
  const faces = [face(box(450, 450, 550, 550), 0.95)];
  const region = computeApplicantPhotoCropRegion(faces, 1000, 1000);

  assert.ok(region, 'expected a non-null crop region');
  assert.ok(region!.width > 100, 'the photo rectangle must be larger than the bare face width');
  assert.ok(region!.height > 100, 'the photo rectangle must be larger than the bare face height');
  // Expanded rectangle must still fully contain the original face box.
  assert.ok(region!.left <= 450);
  assert.ok(region!.top <= 450);
  assert.ok(region!.left + region!.width >= 550);
  assert.ok(region!.top + region!.height >= 550);
});

test('computeApplicantPhotoCropRegion clamps the expanded rectangle to the image bounds when the face sits near an edge', () => {
  // Face in the top-left corner — expansion above/left of (0,0) must clamp, not go negative.
  const faces = [face(box(0, 0, 80, 80), 0.9)];
  const region = computeApplicantPhotoCropRegion(faces, 1000, 1000);

  assert.ok(region, 'expected a non-null crop region even near an edge');
  assert.ok(region!.left >= 0);
  assert.ok(region!.top >= 0);
  assert.ok(region!.left + region!.width <= 1000);
  assert.ok(region!.top + region!.height <= 1000);
});

test('computeApplicantPhotoCropRegion ignores a face below the minimum detection confidence threshold', () => {
  const faces = [face(box(400, 400, 600, 600), 0.2)];
  const region = computeApplicantPhotoCropRegion(faces, 1000, 1000);
  assert.equal(region, null, 'a low-confidence candidate must never produce a crop');
});

test('computeApplicantPhotoCropRegion treats a missing detectionConfidence as zero (never crops on an unscored candidate)', () => {
  const faces = [face(box(400, 400, 600, 600), null)];
  const region = computeApplicantPhotoCropRegion(faces, 1000, 1000);
  assert.equal(region, null);
});

test('computeApplicantPhotoCropRegion picks the LARGEST confident face when multiple faces are present (e.g. a small hologram/ghost-photo artifact alongside the real photo)', () => {
  const realFace = box(400, 400, 600, 600); // 200x200, large — the genuine printed photo's face
  const ghostArtifact = box(50, 50, 80, 80); // 30x30, tiny — a spurious security-pattern match
  const faces = [face(ghostArtifact, 0.8), face(realFace, 0.85)];
  const region = computeApplicantPhotoCropRegion(faces, 1000, 1000);

  assert.ok(region);
  // The crop must be built around the large real face, not the tiny ghost artifact.
  assert.ok(region!.left < 400 && region!.left > 100, 'crop should be anchored near the real face, not the ghost artifact');
  assert.ok(region!.left + region!.width > 600);
});

test('computeApplicantPhotoCropRegion returns null when the resulting crop would be smaller than the minimum dimension (face is a sliver right at the image edge)', () => {
  // A tiny, high-confidence face box crammed into the extreme corner such
  // that most of its expansion clamps away, leaving a crop below the
  // minimum size floor.
  const faces = [face(box(0, 0, 10, 10), 0.99)];
  const region = computeApplicantPhotoCropRegion(faces, 1000, 1000);
  assert.equal(region, null, 'an undersized crop must never be returned — callers should skip the photo entirely instead');
});

test('computeApplicantPhotoCropRegion returns null for a face annotation with no boundingPoly at all', () => {
  const faces: VisionFaceAnnotation[] = [{ boundingPoly: null, detectionConfidence: 0.95 }];
  const region = computeApplicantPhotoCropRegion(faces, 1000, 1000);
  assert.equal(region, null);
});

test('computeApplicantPhotoCropRegion returns null for a face annotation with an empty vertices array', () => {
  const faces: VisionFaceAnnotation[] = [{ boundingPoly: { vertices: [] }, detectionConfidence: 0.95 }];
  const region = computeApplicantPhotoCropRegion(faces, 1000, 1000);
  assert.equal(region, null);
});

test('computeApplicantPhotoCropRegion returns null when the image has zero or negative dimensions', () => {
  const faces = [face(box(10, 10, 100, 100), 0.95)];
  assert.equal(computeApplicantPhotoCropRegion(faces, 0, 1000), null);
  assert.equal(computeApplicantPhotoCropRegion(faces, 1000, 0), null);
  assert.equal(computeApplicantPhotoCropRegion(faces, -5, 1000), null);
});

test('computeApplicantPhotoCropRegion never returns a region that exceeds the image bounds', () => {
  // A very large face relative to a small image, to stress the clamp logic.
  const faces = [face(box(5, 5, 95, 95), 0.9)];
  const region = computeApplicantPhotoCropRegion(faces, 100, 100);
  if (region) {
    assert.ok(region.left >= 0 && region.top >= 0);
    assert.ok(region.left + region.width <= 100);
    assert.ok(region.top + region.height <= 100);
  }
});
