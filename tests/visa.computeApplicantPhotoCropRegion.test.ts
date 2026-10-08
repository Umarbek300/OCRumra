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

// --- layout-aware constraints (right = personal-data column, bottom = MRZ) ---
// Real production passport geometry (406/381/382/380), all independently
// confirmed via this engagement's own read-only Vision diagnostics. The
// `right`/`bottom` values below are each the detected signal (columnX0 /
// mrzTop) minus the SAME margin formula extractApplicantPhotoCrop.ts's own
// buildLayoutConstraints() applies (max(8, 0.012 * dimension)) — this test
// module does not re-implement that formula as a helper on purpose, so a
// change to the margin constants here would have to be a deliberate,
// visible edit to each literal below, not an accidental one via a shared
// function drifting.

test('computeApplicantPhotoCropRegion with no layoutConstraints argument behaves byte-identically to the original 3-argument call (backward compatibility)', () => {
  const faces = [face(box(450, 450, 550, 550), 0.95)];
  const withoutArg = computeApplicantPhotoCropRegion(faces, 1000, 1000);
  const withUndefined = computeApplicantPhotoCropRegion(faces, 1000, 1000, undefined);
  assert.deepEqual(withoutArg, withUndefined);
});

test('real passport 406: right+bottom layout constraints both apply, shrinking the crop while keeping the face fully contained', () => {
  const faces = [face(box(139, 746, 341, 981), 0.988)];
  const base = computeApplicantPhotoCropRegion(faces, 960, 1280);
  assert.ok(base);

  const right = 378 - Math.max(8, 0.012 * 960); // columnX0=378, margin≈11.52
  const bottom = 1100 - Math.max(8, 0.012 * 1280); // mrzTop=1100, margin≈15.36
  const region = computeApplicantPhotoCropRegion(faces, 960, 1280, { right, bottom });

  assert.ok(region);
  assert.ok(region!.width < base!.width, 'the right constraint must shrink the crop versus the face-only base');
  assert.ok(region!.height < base!.height, 'the bottom constraint must shrink the crop versus the face-only base');
  // Face (x1=341, y1=981) must remain fully inside the constrained crop.
  assert.ok(region!.left + region!.width >= 341);
  assert.ok(region!.top + region!.height >= 981);
});

test('real passport 381: right+bottom layout constraints both apply, matching this engagement\'s own hand-verified diagnostic', () => {
  const faces = [face(box(60, 776, 264, 1014), 0.98828125)];
  const base = computeApplicantPhotoCropRegion(faces, 960, 1280);
  assert.ok(base);

  const right = 310 - Math.max(8, 0.012 * 960); // real columnX0=310
  const bottom = 1135 - Math.max(8, 0.012 * 1280); // real mrzTop=1135
  const region = computeApplicantPhotoCropRegion(faces, 960, 1280, { right, bottom });

  assert.ok(region);
  assert.ok(region!.left + region!.width >= 264, 'face x1 must stay inside the crop');
  assert.ok(region!.top + region!.height >= 1014, 'face y1 must stay inside the crop');
  assert.ok(region!.width < base!.width);
  assert.ok(region!.height < base!.height);
});

test('real passport 382: the right constraint has a tight (~18px) containment budget over the face and must still be accepted, not dropped', () => {
  const faces = [face(box(64, 749, 308, 1033), 0.914)];
  const base = computeApplicantPhotoCropRegion(faces, 960, 1280);
  assert.ok(base);

  const right = 338 - Math.max(8, 0.012 * 960); // real columnX0=338, face.x1=308 -> gap ≈18.5px
  const bottom = 1129 - Math.max(8, 0.012 * 1280); // real mrzTop=1129
  const region = computeApplicantPhotoCropRegion(faces, 960, 1280, { right, bottom });

  assert.ok(region, 'the tight-but-sufficient containment margin must not cause the whole crop to fail');
  assert.ok(region!.left + region!.width >= 308);
  assert.ok(region!.width < base!.width, 'the tight right constraint must still have been applied, not silently dropped');
});

test('real passport 380: a landscape (1280x912) original image is handled identically to a portrait one', () => {
  const faces = [face(box(52, 242, 350, 589), 0.992)];
  const base = computeApplicantPhotoCropRegion(faces, 1280, 912);
  assert.ok(base);

  const right = 406 - Math.max(8, 0.012 * 1280); // real columnX0=406
  const bottom = 751 - Math.max(8, 0.012 * 912); // real mrzTop=751
  const region = computeApplicantPhotoCropRegion(faces, 1280, 912, { right, bottom });

  assert.ok(region);
  assert.ok(region!.left + region!.width >= 350);
  assert.ok(region!.top + region!.height >= 589);
  assert.ok(region!.width < base!.width);
  assert.ok(region!.height < base!.height);
});

test('a right constraint that would cut into the face (violates the containment padding) is dropped, falling back toward the bottom-only/base region', () => {
  const faces = [face(box(450, 450, 550, 550), 0.95)]; // faceWidth=100 -> minFaceRightPadding = max(8, 5) = 8
  const base = computeApplicantPhotoCropRegion(faces, 1000, 1000);
  assert.ok(base);

  const region = computeApplicantPhotoCropRegion(faces, 1000, 1000, { right: 550 }); // exactly at face.x1, violates the +8px minimum padding
  assert.ok(region);
  assert.deepEqual(region, base, 'an unsafe right constraint must be dropped entirely, reproducing the pure face-only base region');
});

test('a bottom constraint that would cut into the face is dropped, falling back toward the right-only/base region', () => {
  const faces = [face(box(450, 450, 550, 550), 0.95)];
  const base = computeApplicantPhotoCropRegion(faces, 1000, 1000);
  assert.ok(base);

  const region = computeApplicantPhotoCropRegion(faces, 1000, 1000, { bottom: 552 }); // 2px below face.y1, violates the +8px minimum padding
  assert.deepEqual(region, base);
});

test('when only the right constraint is reliable (confidence gating happens in the caller — here simply omitting bottom), only right is applied', () => {
  const faces = [face(box(139, 746, 341, 981), 0.988)];
  const base = computeApplicantPhotoCropRegion(faces, 960, 1280);
  assert.ok(base);

  const right = 378 - Math.max(8, 0.012 * 960);
  const region = computeApplicantPhotoCropRegion(faces, 960, 1280, { right });

  assert.ok(region);
  assert.ok(region!.width < base!.width);
  assert.equal(region!.height, base!.height, 'bottom must stay exactly at the face-only base when no bottom constraint is given');
});

test('when only the bottom constraint is reliable, only bottom is applied', () => {
  const faces = [face(box(139, 746, 341, 981), 0.988)];
  const base = computeApplicantPhotoCropRegion(faces, 960, 1280);
  assert.ok(base);

  const bottom = 1100 - Math.max(8, 0.012 * 1280);
  const region = computeApplicantPhotoCropRegion(faces, 960, 1280, { bottom });

  assert.ok(region);
  assert.equal(region!.width, base!.width, 'right must stay exactly at the face-only base when no right constraint is given');
  assert.ok(region!.height < base!.height);
});

test('a right constraint that would shrink the crop below MIN_CROP_DIMENSION_PIXELS is dropped rather than returning an undersized/null crop', () => {
  // Face near the left edge of a narrow image; an aggressively tight right
  // constraint (just past the face's own right edge) would otherwise
  // produce a crop narrower than the 80px floor.
  const faces = [face(box(10, 400, 60, 450), 0.95)]; // faceWidth=50, minFaceRightPadding=max(8,2.5)=8
  const base = computeApplicantPhotoCropRegion(faces, 1000, 1000);
  assert.ok(base);

  const region = computeApplicantPhotoCropRegion(faces, 1000, 1000, { right: 72 }); // 60+12, passes containment but yields a tiny crop
  assert.ok(region, 'must fall back to the base region rather than returning null when the constrained crop is undersized');
  assert.equal(region!.width, base!.width);
});
