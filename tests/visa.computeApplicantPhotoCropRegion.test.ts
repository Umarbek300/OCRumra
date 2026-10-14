import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyTargetAspectRatio,
  computeApplicantPhotoCropRegion,
  type VisionFaceAnnotation,
} from '../src/visa/computeApplicantPhotoCropRegion.js';

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

test('real passport 406: the right layout constraint applies and shrinks the crop; the bottom constraint is correctly rejected now that it is no longer tighter than the (smaller, post-retune) face-only base', () => {
  const faces = [face(box(139, 746, 341, 981), 0.988)];
  const base = computeApplicantPhotoCropRegion(faces, 960, 1280);
  assert.ok(base);

  const right = 378 - Math.max(8, 0.012 * 960); // columnX0=378, margin≈11.52
  const bottom = 1100 - Math.max(8, 0.012 * 1280); // mrzTop=1100, margin≈15.36
  const region = computeApplicantPhotoCropRegion(faces, 960, 1280, { right, bottom });

  assert.ok(region);
  assert.ok(region!.width < base!.width, 'the right constraint must shrink the crop versus the face-only base');
  // BOTTOM_MARGIN_FACTOR was tightened (0.7 -> 0.35) since this test's values
  // were first written: the face-only base now already ends above this real
  // mrzTop-derived bottom signal, so the constraint is correctly rejected as
  // redundant rather than applied -- not a regression, see
  // computeApplicantPhotoCropRegion's own acceptedBottom gating.
  assert.equal(region!.height, base!.height, 'the bottom constraint is no longer tighter than the face-only base and must be rejected, not applied');
  // Face (x1=341, y1=981) must remain fully inside the constrained crop.
  assert.ok(region!.left + region!.width >= 341);
  assert.ok(region!.top + region!.height >= 981);
});

test('real passport 381: the right layout constraint applies and shrinks the crop; the bottom constraint is correctly rejected now that it is no longer tighter than the (smaller, post-retune) face-only base', () => {
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
  // See the 406 test above: BOTTOM_MARGIN_FACTOR's retune means this real
  // mrzTop-derived bottom signal is no longer tighter than the face-only base.
  assert.equal(region!.height, base!.height, 'the bottom constraint is no longer tighter than the face-only base and must be rejected, not applied');
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
  // See the 406 test above: BOTTOM_MARGIN_FACTOR's retune means this real
  // mrzTop-derived bottom signal is no longer tighter than the face-only base.
  assert.equal(region!.height, base!.height, 'the bottom constraint is no longer tighter than the face-only base and must be rejected, not applied');
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

test('when only a bottom constraint is given but it is no longer tighter than the (post-retune) face-only base, it is correctly rejected rather than applied', () => {
  const faces = [face(box(139, 746, 341, 981), 0.988)];
  const base = computeApplicantPhotoCropRegion(faces, 960, 1280);
  assert.ok(base);

  const bottom = 1100 - Math.max(8, 0.012 * 1280);
  const region = computeApplicantPhotoCropRegion(faces, 960, 1280, { bottom });

  assert.ok(region);
  assert.equal(region!.width, base!.width, 'right must stay exactly at the face-only base when no right constraint is given');
  // BOTTOM_MARGIN_FACTOR's retune (0.7 -> 0.35) means this real mrzTop-derived
  // bottom signal is no longer tighter than the face-only base -- the whole
  // constraint is correctly dropped (see the fallback cascade's last attempt),
  // reproducing the base region exactly.
  assert.deepEqual(region, base, 'a bottom constraint no longer tighter than the base must reproduce the base region exactly, not shrink it');
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

// --- B: appliedRightConstraint / appliedBottomConstraint metadata --------
// These fields exist so extractApplicantPhotoCrop.ts's applyTargetAspectRatio
// step can tell which edges were ACTUALLY used to produce a region (a real
// hard bound it must respect), as opposed to a constraint that was merely
// offered and rejected by the fallback cascade above. "Actually affects the
// final crop width/height" is exactly what these tests confirm.

test('B: computeApplicantPhotoCropRegion sets appliedRightConstraint to the exact accepted value when the right constraint is applied, and actually narrows the crop width', () => {
  const faces = [face(box(139, 746, 341, 981), 0.988)]; // real passport 406 face geometry
  const base = computeApplicantPhotoCropRegion(faces, 960, 1280);
  assert.ok(base);

  const right = 378 - Math.max(8, 0.012 * 960); // real columnX0=378
  const region = computeApplicantPhotoCropRegion(faces, 960, 1280, { right });

  assert.ok(region);
  assert.equal(region!.appliedRightConstraint, right, 'appliedRightConstraint must record exactly the accepted right edge');
  assert.equal(region!.appliedBottomConstraint, undefined, 'no bottom constraint was given, so it must stay unset');
  assert.ok(region!.width < base!.width, 'the applied right constraint must actually narrow the final crop width');
});

test('B: computeApplicantPhotoCropRegion sets appliedBottomConstraint to the exact accepted value when a bottom constraint tighter than the face-only base is applied, and actually shortens the crop height', () => {
  // Synthetic geometry (unlike every real-passport fixture above, which no
  // longer has a bottom signal tighter than the base under the retuned
  // BOTTOM_MARGIN_FACTOR=0.35): a face with room below it, so a bottom
  // constraint can still be meaningfully tighter than the face-only base.
  const faces = [face(box(300, 100, 500, 300), 0.95)]; // faceWidth=200, faceHeight=200
  const base = computeApplicantPhotoCropRegion(faces, 1000, 1000);
  assert.ok(base);
  // base bottom = 300 + 200*0.35 = 370; minFaceBottomPadding = max(8, 10) = 10.
  const bottom = 320; // comfortably between face.y1+padding (310) and base bottom (370)
  const region = computeApplicantPhotoCropRegion(faces, 1000, 1000, { bottom });

  assert.ok(region);
  assert.equal(region!.appliedBottomConstraint, bottom);
  assert.equal(region!.appliedRightConstraint, undefined);
  assert.ok(region!.height < base!.height, 'the applied bottom constraint must actually shorten the final crop height');
});

test('B: computeApplicantPhotoCropRegion sets BOTH appliedRightConstraint and appliedBottomConstraint when both are simultaneously tighter than the base and accepted together', () => {
  const faces = [face(box(300, 100, 500, 300), 0.95)];
  const base = computeApplicantPhotoCropRegion(faces, 1000, 1000);
  assert.ok(base);

  const region = computeApplicantPhotoCropRegion(faces, 1000, 1000, { right: 550, bottom: 320 });

  assert.ok(region);
  assert.equal(region!.appliedRightConstraint, 550);
  assert.equal(region!.appliedBottomConstraint, 320);
  assert.ok(region!.width < base!.width && region!.height < base!.height);
});

// --- applyTargetAspectRatio: priority-ordered invariants ------------------
// Priority order (highest first): 1) face never cut, 2) hard bounds never
// crossed, 3) the incoming region's own width/height are never shrunk
// EXCEPT where that would conflict with priority 2, 4) target ratio (0.78)
// approached as closely as 1-3 allow. Every value below is hand-derived
// from the function's own documented algorithm (see
// src/visa/computeApplicantPhotoCropRegion.ts), not guessed.

test('applyTargetAspectRatio (C): a tight hard RIGHT bound (e.g. an applied personal-data-column constraint) is never crossed, even though reaching the target ratio would require more width -- the ratio is sacrificed instead', () => {
  const region = { left: 0, top: 0, width: 100, height: 200 }; // ratio 0.5
  const faceBox = { x0: 20, y0: 40, x1: 80, y1: 180 }; // safely inside the incoming region
  const result = applyTargetAspectRatio(region, 0.78, faceBox, 0, 0, 120, 1000);

  assert.deepEqual(result, { left: 0, top: 0, width: 120, height: 200 });
  assert.ok(result.left + result.width <= 120, 'must never cross the hard RIGHT bound (120), even though ratio 0.78 would want width=156');
  assert.ok(result.left <= faceBox.x0 && result.top <= faceBox.y0 && result.left + result.width >= faceBox.x1 && result.top + result.height >= faceBox.y1);
});

test('applyTargetAspectRatio: a tight hard BOTTOM bound is never crossed when height needs to grow to reach the target ratio -- the ratio is sacrificed instead', () => {
  const region = { left: 0, top: 0, width: 200, height: 100 }; // ratio 2.0
  const faceBox = { x0: 20, y0: 10, x1: 180, y1: 90 };
  const result = applyTargetAspectRatio(region, 0.78, faceBox, 0, 0, 1000, 120);

  assert.deepEqual(result, { left: 0, top: 0, width: 200, height: 120 });
  assert.ok(result.top + result.height <= 120, 'must never cross the hard BOTTOM bound (120)');
});

test('applyTargetAspectRatio: never shrinks either dimension of the incoming region when hard bounds are generous, and reaches the target ratio exactly when nothing prevents it', () => {
  const region = { left: 100, top: 100, width: 100, height: 200 };
  const faceBox = { x0: 120, y0: 120, x1: 180, y1: 280 };
  const result = applyTargetAspectRatio(region, 0.78, faceBox, 0, 0, 1000, 1000);

  assert.deepEqual(result, { left: 72, top: 100, width: 156, height: 200 });
  assert.ok(result.width >= region.width, 'width must never shrink below the incoming region');
  assert.ok(result.height >= region.height, 'height must never shrink below the incoming region');
  assert.ok(Math.abs(result.width / result.height - 0.78) < 1e-9, 'ratio 0.78 must be reached exactly when nothing else constrains it');
});

test('applyTargetAspectRatio: the ONE sanctioned exception to never-shrink -- when the incoming region already exceeds the hard bounds (a caller inconsistency, not a normal case), it shrinks down to the hard bound rather than violating it', () => {
  const region = { left: 0, top: 0, width: 150, height: 200 }; // already exceeds hardRight below
  const faceBox = { x0: 10, y0: 50, x1: 90, y1: 150 }; // still fits once shrunk to the hard bound
  const result = applyTargetAspectRatio(region, 0.78, faceBox, 0, 0, 100, 1000);

  assert.deepEqual(result, { left: 0, top: 0, width: 100, height: 200 });
  assert.ok(result.width < region.width, 'priority 2 (hard bounds) outranks priority 3 (never shrink) only in this conflict case');
  assert.ok(result.left + result.width <= 100);
});

test('applyTargetAspectRatio: falls back to returning the original region completely unchanged if the face itself cannot fit within the hard bounds at all (should be unreachable by construction, but must never ship an invalid crop)', () => {
  const region = { left: 0, top: 0, width: 250, height: 250 };
  // Impossible hard bound: the face (200px wide) is wider than the
  // available hard width (100px) -- no rectangle can satisfy both face
  // containment and this hard bound simultaneously.
  const faceBox = { x0: 0, y0: 0, x1: 200, y1: 200 };
  const result = applyTargetAspectRatio(region, 0.78, faceBox, 0, 0, 100, 1000);

  assert.deepEqual(result, region, 'must return the original region unchanged rather than ship an invalid crop');
});

// --- rounding robustness: fractional hard bounds (e.g. a real
// documentBoundary.x0/x1, which is a union-of-text-boxes union and so is
// essentially never an integer) must never let independent rounding of
// left/width (or top/height) push the result past the hard bound by more
// than the function's own EPSILON=0.5 tolerance. Rounding `left` and
// `width` SEPARATELY can drift the resulting right edge by up to 1px (two
// independent ±0.5 roundings compounding in the same direction) -- this
// module rounds the EDGES (left/right, top/bottom) instead, so each hard
// bound only ever has one rounding decision made against it. Every value
// below was confirmed against the actual implementation via a targeted
// numeric sweep (not guessed), and reproduces the exact worst case that
// sweep found before this fix (overshoot = 0.8px, i.e. an actual 1px-off
// integer crop, silently returned as "valid").

test('applyTargetAspectRatio: a fractional hard RIGHT bound that both sides saturate against is rounded as ONE edge decision, never drifting the result past it (the exact adversarial case this rounding fix addresses)', () => {
  // hardLeft=10.6 and hardRight=101.2 are deliberately fractional, matching
  // a real documentBoundary.x0/x1 (never an integer in practice -- see
  // detectDocumentBoundary.ts's BOUNDARY_MARGIN_FRACTION expansion).
  // Before the edge-rounding fix, independently rounding width≈90.6 (up to
  // 91) and left≈10.6 (up to 11) compounded to left+width=102, which
  // overshoots hardRight(101.2) by 0.8px -- more than the 0.5 EPSILON the
  // defensive check tolerates, so the OLD code would have silently
  // discarded this perfectly achievable aspect-ratio improvement and
  // fallen back to the unmodified region instead.
  const region = { left: 50, top: 0, width: 10, height: 500 };
  const faceBox = { x0: 52, y0: 10, x1: 58, y1: 490 };
  const result = applyTargetAspectRatio(region, 50, faceBox, 10.6, 0, 101.2, 1000);

  assert.deepEqual(result, { left: 11, top: 0, width: 90, height: 500 });
  assert.ok(result.left + result.width <= 101.2, 'must never cross the fractional hard RIGHT bound');
  assert.ok(result.left >= 10.6 - 0.5, 'must stay within tolerance of the fractional hard LEFT bound');
  assert.ok(faceBox.x0 >= result.left && faceBox.x1 <= result.left + result.width, 'face must remain fully contained');
});

test('applyTargetAspectRatio: the same fractional-hard-bound rounding case, mirrored on the BOTTOM/TOP axis', () => {
  const region = { left: 0, top: 50, width: 500, height: 10 };
  const faceBox = { x0: 10, y0: 52, x1: 490, y1: 58 };
  const result = applyTargetAspectRatio(region, 1 / 50, faceBox, 0, 10.6, 1000, 101.2);

  assert.deepEqual(result, { left: 0, top: 11, width: 500, height: 90 });
  assert.ok(result.top + result.height <= 101.2, 'must never cross the fractional hard BOTTOM bound');
  assert.ok(result.top >= 10.6 - 0.5, 'must stay within tolerance of the fractional hard TOP bound');
  assert.ok(faceBox.y0 >= result.top && faceBox.y1 <= result.top + result.height, 'face must remain fully contained');
});

test('applyTargetAspectRatio: a wide sweep of fractional hard RIGHT bounds never produces an overshoot beyond the 0.5 EPSILON tolerance', () => {
  let maxOvershoot = -Infinity;
  for (let hardLeftFrac = 0; hardLeftFrac < 1; hardLeftFrac += 0.07) {
    for (let hardRightFrac = 0; hardRightFrac < 1; hardRightFrac += 0.09) {
      const hardLeft = 10 + hardLeftFrac;
      const hardRight = 200 + hardRightFrac;
      const region = { left: 100, top: 0, width: 10, height: 500 };
      const faceBox = { x0: 102, y0: 10, x1: 108, y1: 490 };
      const result = applyTargetAspectRatio(region, 50, faceBox, hardLeft, 0, hardRight, 1000);
      maxOvershoot = Math.max(maxOvershoot, result.left + result.width - hardRight);
    }
  }
  assert.ok(maxOvershoot <= 0.5, `max overshoot across the sweep must never exceed the 0.5 EPSILON tolerance (found ${maxOvershoot})`);
});

// --- MEDIUM-confidence columnResult: extractApplicantPhotoCrop.ts now also
// supplies a RIGHT constraint when columnResult.confidence is 'MEDIUM', using
// the EXACT SAME margin formula as HIGH (no new/extra margin). This module
// itself (computeApplicantPhotoCropRegion) is UNCHANGED by that -- it has no
// confidence parameter at all, so its own accept/reject cascade is exactly
// as strict for a MEDIUM-sourced `right` value as for a HIGH-sourced one.
// These 8 tests exercise that EXISTING, unmodified cascade directly against
// every real face+columnX0 geometry on record in this engagement
// (406/381/382/380/408/409/410 from the real-passport diagnostics already
// used elsewhere in this file, plus 414 -- the one real passport whose
// detectPersonalDataColumn confidence is genuinely MEDIUM today; see
// tests/visa.detectPersonalDataColumn.test.ts). Each expected value below
// was independently verified by running computeApplicantPhotoCropRegion
// itself, not hand-derived.

test('MEDIUM column (real geometry, treated as if the constraint were offered at MEDIUM confidence): 406 -- accepted, narrows the crop', () => {
  const faces = [face(box(139, 746, 341, 981), 0.988)];
  const base = computeApplicantPhotoCropRegion(faces, 960, 1280);
  assert.ok(base);
  const right = 378 - Math.max(8, 0.012 * 960); // real columnX0=378, same HIGH-tier margin formula
  const region = computeApplicantPhotoCropRegion(faces, 960, 1280, { right });

  assert.ok(region);
  assert.equal(region!.appliedRightConstraint, right, 'minFaceRightPadding accepts this real gap (37px) -- the constraint is applied');
  assert.equal(region!.width, 339);
  assert.ok(region!.width < base!.width);
});

test('MEDIUM column (real geometry): 381 -- accepted, matches the already-verified real pipeline result (298px)', () => {
  const faces = [face(box(60, 776, 264, 1014), 0.98828125)];
  const base = computeApplicantPhotoCropRegion(faces, 960, 1280);
  assert.ok(base);
  const right = 310 - Math.max(8, 0.012 * 960); // real columnX0=310
  const region = computeApplicantPhotoCropRegion(faces, 960, 1280, { right });

  assert.ok(region);
  assert.equal(region!.appliedRightConstraint, right);
  assert.equal(region!.width, 298);
});

test('MEDIUM column (real geometry): 382 -- accepted, narrows the crop', () => {
  const faces = [face(box(64, 749, 308, 1033), 0.914)];
  const base = computeApplicantPhotoCropRegion(faces, 960, 1280);
  assert.ok(base);
  const right = 338 - Math.max(8, 0.012 * 960); // real columnX0=338
  const region = computeApplicantPhotoCropRegion(faces, 960, 1280, { right });

  assert.ok(region);
  assert.equal(region!.appliedRightConstraint, right);
  assert.equal(region!.width, 326);
  assert.ok(region!.width < base!.width);
});

test('MEDIUM column (real geometry): 380 (landscape, 1280x912) -- accepted, narrows the crop', () => {
  const faces = [face(box(52, 242, 350, 589), 0.992)];
  const base = computeApplicantPhotoCropRegion(faces, 1280, 912);
  assert.ok(base);
  const right = 406 - Math.max(8, 0.012 * 1280); // real columnX0=406
  const region = computeApplicantPhotoCropRegion(faces, 1280, 912, { right });

  assert.ok(region);
  assert.equal(region!.appliedRightConstraint, right);
  assert.equal(region!.width, 391);
  assert.ok(region!.width < base!.width);
});

test('MEDIUM column (real geometry): 408 -- accepted, narrows the crop', () => {
  const faces = [face(box(135, 770, 312, 975), 0.95)];
  const base = computeApplicantPhotoCropRegion(faces, 960, 1280);
  assert.ok(base);
  const right = 346 - Math.max(8, 0.012 * 960); // real columnX0=346
  const region = computeApplicantPhotoCropRegion(faces, 960, 1280, { right });

  assert.ok(region);
  assert.equal(region!.appliedRightConstraint, right);
  assert.equal(region!.width, 297);
  assert.ok(region!.width < base!.width);
});

test('MEDIUM column (real geometry): 409 -- accepted, narrows the crop', () => {
  const faces = [face(box(115, 809, 332, 1061), 0.95)];
  const base = computeApplicantPhotoCropRegion(faces, 960, 1280);
  assert.ok(base);
  const right = 363 - Math.max(8, 0.012 * 960); // real columnX0=363
  const region = computeApplicantPhotoCropRegion(faces, 960, 1280, { right });

  assert.ok(region);
  assert.equal(region!.appliedRightConstraint, right);
  assert.equal(region!.width, 351);
  assert.ok(region!.width < base!.width);
});

test('MEDIUM column (real geometry): 410 -- accepted, narrows the crop', () => {
  const faces = [face(box(151, 805, 322, 1004), 0.95)];
  const base = computeApplicantPhotoCropRegion(faces, 960, 1280);
  assert.ok(base);
  const right = 355 - Math.max(8, 0.012 * 960); // real columnX0=355
  const region = computeApplicantPhotoCropRegion(faces, 960, 1280, { right });

  assert.ok(region);
  assert.equal(region!.appliedRightConstraint, right);
  assert.equal(region!.width, 287);
  assert.ok(region!.width < base!.width);
});

test('MEDIUM column (real geometry): 414 -- REJECTED by minFaceRightPadding, the ONLY real MEDIUM example whose gap (19px) is tighter than every other real sample (30-56px)', () => {
  const faces = [face(box(88, 784, 266, 991), 0.95)];
  const base = computeApplicantPhotoCropRegion(faces, 896, 1280);
  assert.ok(base);
  const right = 285 - Math.max(8, 0.012 * 896); // real columnX0=285 -> right=274.25
  const region = computeApplicantPhotoCropRegion(faces, 896, 1280, { right });

  assert.ok(region, 'must fall back to the face-only base, never return null');
  // 274.25 < box.x1(266) + minFaceRightPadding(max(8, 0.05*178)=8.9) = 274.9 --
  // computeApplicantPhotoCropRegion.ts's own acceptedRight check rejects it.
  assert.equal(region!.appliedRightConstraint, undefined, 'the constraint must be rejected, not applied');
  assert.equal(region!.width, base!.width, 'must reproduce the face-only base exactly -- the same protection as any rejected HIGH constraint');
  assert.deepEqual(region, base);
});
