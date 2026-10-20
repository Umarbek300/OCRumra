import type { VisionBoundingPoly } from '../ocr/visual/extractIssueDateFromVisionStructure.js';

/**
 * Loose/local shape for Google Vision's FaceAnnotation -- same deliberate
 * looseness as VisionWord/VisionPage in extractIssueDateFromVisionStructure.ts,
 * trivially unit-testable with synthetic fixtures while remaining
 * structurally compatible with the real
 * protos.google.cloud.vision.v1.IFaceAnnotation shape. Only the two fields
 * this module actually needs are modeled -- landmarks/angles are unused.
 *
 * `boundingPoly` (not the tighter `fdBoundingPoly`) is used deliberately:
 * Vision's own proto docs describe it as "computed to frame the face in
 * accordance with human expectations" (includes forehead/hair/chin), which
 * is the right starting rectangle to expand outward into the full printed
 * photo region -- fd_bounding_poly is tighter (skin only) and would need a
 * larger, less certain expansion to reach the same target.
 */
export interface VisionFaceAnnotation {
  boundingPoly?: VisionBoundingPoly | null;
  detectionConfidence?: number | null;
}

export interface PixelCropRegion {
  left: number;
  top: number;
  width: number;
  height: number;
  /**
   * Set ONLY when the RIGHT layout constraint (personal-data column, see
   * LayoutConstraints.right) was actually the edge used to produce this
   * region's width -- never merely offered-but-rejected by the fallback
   * cascade below. Callers (extractApplicantPhotoCrop.ts's
   * applyTargetAspectRatio step) use this to know which edges are a real
   * "hard bound" the aspect-ratio step must not cross, as opposed to a
   * constraint that was available but not actually applied.
   */
  appliedRightConstraint?: number;
  /** Same as appliedRightConstraint, for the BOTTOM constraint (MRZ, see LayoutConstraints.bottom). */
  appliedBottomConstraint?: number;
}

export interface PixelBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Optional layout-aware boundaries (see extractApplicantPhotoCrop.ts,
 * detectPersonalDataColumn.ts, locateMrzParagraphGeometry.ts), each already
 * margin-adjusted by the caller — this module's only job with them is
 * containment/min-size validation and the fallback cascade below. Absent
 * fields (the default — no 4th argument passed at all) leave this
 * function's behavior byte-identical to its original face-only form.
 */
export interface LayoutConstraints {
  /** Candidate right edge (pixels) — typically the detected personal-data column's left edge minus a safety margin. */
  right?: number;
  /** Candidate bottom edge (pixels) — typically the detected MRZ paragraph's top edge minus a safety margin. */
  bottom?: number;
}

const MIN_DETECTION_CONFIDENCE = 0.5;
const MIN_CROP_DIMENSION_PIXELS = 80;

// Expansion factors approximate a standard passport/ID photo crop around a
// detected face: generous headroom above (hair/headwear), a smaller margin
// below (chin/neck/shoulders), and symmetric side margins. This is a
// starting heuristic, not a measured photographic standard -- it should be
// retuned against real production photos (see extractApplicantPhotoCrop.ts).
const TOP_MARGIN_FACTOR = 0.4;
const BOTTOM_MARGIN_FACTOR = 0.35;
const SIDE_MARGIN_FACTOR = 0.55;

function faceBoundingBoxPixels(face: VisionFaceAnnotation): PixelBox | null {
  const vertices = face.boundingPoly?.vertices;
  if (!vertices || vertices.length === 0) return null;
  const xs = vertices.map((v) => v.x ?? null).filter((x): x is number => x !== null);
  const ys = vertices.map((v) => v.y ?? null).filter((y): y is number => y !== null);
  if (xs.length === 0 || ys.length === 0) return null;
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

function boxArea(box: PixelBox): number {
  return Math.max(0, box.x1 - box.x0) * Math.max(0, box.y1 - box.y0);
}

/**
 * Picks the single most likely "this is the ID photo's face" candidate out
 * of every face Vision found on the page. A real passport's printed
 * security pattern/hologram/ghost-photo sometimes triggers a spurious,
 * small, low-confidence face match too, so this never just takes the first
 * result: it requires a minimum detection confidence, then prefers the
 * LARGEST confident face -- the genuine photo's face is always
 * substantially bigger in frame than a hologram/security-pattern artifact.
 */
function selectBestFace(faces: readonly VisionFaceAnnotation[]): VisionFaceAnnotation | null {
  let best: { face: VisionFaceAnnotation; area: number } | null = null;
  for (const face of faces) {
    const confidence = face.detectionConfidence ?? 0;
    if (confidence < MIN_DETECTION_CONFIDENCE) continue;
    const box = faceBoundingBoxPixels(face);
    if (!box) continue;
    const area = boxArea(box);
    if (area <= 0) continue;
    if (best === null || area > best.area) best = { face, area };
  }
  return best?.face ?? null;
}

/**
 * Exposes the SAME "pick the largest confident face" box this module uses
 * internally, for callers (extractApplicantPhotoCrop.ts's layout-aware
 * constraint detection) that need the raw face box itself rather than the
 * already-expanded crop rectangle computeApplicantPhotoCropRegion returns.
 * Returns null under the exact same conditions computeApplicantPhotoCropRegion
 * would (no confident face found) — guarantees the crop computation and the
 * layout-constraint detection always agree on which face is "the" face.
 */
export function selectBestFaceBox(faces: readonly VisionFaceAnnotation[]): PixelBox | null {
  const face = selectBestFace(faces);
  if (!face) return null;
  return faceBoundingBoxPixels(face);
}

/**
 * Minimum safe gap (pixels), scaled by face width and floored at a fixed
 * minimum, that a RIGHT layout constraint (personal-data column) must clear
 * past the face's own right edge before computeApplicantPhotoCropRegion's
 * acceptance check below will trust it. Exported so a caller that needs to
 * pre-validate a candidate RIGHT value BEFORE calling
 * computeApplicantPhotoCropRegion (see extractApplicantPhotoCrop.ts's
 * buildLayoutConstraintsFromParagraphs) uses the exact same formula this
 * module's own acceptance check applies, instead of an independently
 * maintained copy that could silently drift out of sync with it.
 */
export function computeMinFaceRightPadding(faceWidth: number): number {
  return Math.max(8, 0.05 * faceWidth);
}

/**
 * Computes the passport PHOTO rectangle (the full printed portrait, not
 * just the face) from Google Vision's FACE_DETECTION result, by expanding
 * the best-matching detected face's framing bounding box outward by fixed
 * margins and clamping to the image bounds.
 *
 * Returns null -- never a guessed or undersized rectangle -- when: no face
 * was found, every candidate's confidence is below the threshold, or the
 * resulting crop would be smaller than a sane minimum (e.g. the face sat
 * right at the image edge and clamping shrank it away). Callers must treat
 * null as "skip creating a photo for this message", never as an error and
 * never by falling back to uploading the original, uncropped image.
 */
export function computeApplicantPhotoCropRegion(
  faces: readonly VisionFaceAnnotation[],
  imageWidth: number,
  imageHeight: number,
  layoutConstraints?: LayoutConstraints,
): PixelCropRegion | null {
  if (imageWidth <= 0 || imageHeight <= 0) return null;

  const face = selectBestFace(faces);
  if (!face) return null;

  const box = faceBoundingBoxPixels(face);
  if (!box) return null;

  const faceWidth = box.x1 - box.x0;
  const faceHeight = box.y1 - box.y0;
  if (faceWidth <= 0 || faceHeight <= 0) return null;

  const expandedX0 = box.x0 - faceWidth * SIDE_MARGIN_FACTOR;
  const expandedX1 = box.x1 + faceWidth * SIDE_MARGIN_FACTOR;
  const expandedY0 = box.y0 - faceHeight * TOP_MARGIN_FACTOR;
  const expandedY1 = box.y1 + faceHeight * BOTTOM_MARGIN_FACTOR;

  const clampedX0 = Math.max(0, expandedX0);
  const clampedY0 = Math.max(0, expandedY0);
  const clampedX1 = Math.min(imageWidth, expandedX1);
  const clampedY1 = Math.min(imageHeight, expandedY1);

  // Layout-aware boundaries (personal-data column -> right, MRZ -> bottom)
  // are only ever allowed to pull the base face-only envelope INWARD, never
  // to expand it, and only when the face itself stays safely contained —
  // each constraint is validated independently so one being rejected never
  // drags the other down with it. minFaceRightPadding/minFaceBottomPadding
  // use the RAW face box (not the already-expanded one) scaled by its own
  // width/height, matching the real-passport calibration in this
  // engagement's own diagnostics (see detectPersonalDataColumn.ts,
  // locateMrzParagraphGeometry.ts).
  const minFaceRightPadding = computeMinFaceRightPadding(faceWidth);
  const minFaceBottomPadding = Math.max(8, 0.05 * faceHeight);

  const acceptedRight =
    layoutConstraints?.right !== undefined &&
    layoutConstraints.right >= box.x1 + minFaceRightPadding &&
    layoutConstraints.right < clampedX1
      ? layoutConstraints.right
      : null;
  const acceptedBottom =
    layoutConstraints?.bottom !== undefined &&
    layoutConstraints.bottom >= box.y1 + minFaceBottomPadding &&
    layoutConstraints.bottom < clampedY1
      ? layoutConstraints.bottom
      : null;

  // 4-level fallback cascade: both constraints -> right only -> bottom only
  // -> neither (the original, pure face-only envelope — always last, and
  // the ONLY attempt at all when layoutConstraints is omitted entirely, so
  // behavior for every existing caller/test stays byte-identical).
  const attempts: Array<{ x1: number; y1: number }> = [];
  if (acceptedRight !== null && acceptedBottom !== null) attempts.push({ x1: acceptedRight, y1: acceptedBottom });
  if (acceptedRight !== null) attempts.push({ x1: acceptedRight, y1: clampedY1 });
  if (acceptedBottom !== null) attempts.push({ x1: clampedX1, y1: acceptedBottom });
  attempts.push({ x1: clampedX1, y1: clampedY1 });

  for (const attempt of attempts) {
    const width = Math.round(attempt.x1 - clampedX0);
    const height = Math.round(attempt.y1 - clampedY0);
    if (width < MIN_CROP_DIMENSION_PIXELS || height < MIN_CROP_DIMENSION_PIXELS) continue;

    const left = Math.round(clampedX0);
    const top = Math.round(clampedY0);
    // Rounding left/top up and width/height down (via Math.round independently)
    // can occasionally push left+width or top+height one pixel past the
    // image bounds -- clamp the extent here too so sharp's extract() never
    // receives an out-of-bounds region.
    const safeWidth = Math.min(width, Math.floor(imageWidth) - left);
    const safeHeight = Math.min(height, Math.floor(imageHeight) - top);
    if (safeWidth < MIN_CROP_DIMENSION_PIXELS || safeHeight < MIN_CROP_DIMENSION_PIXELS) continue;

    // attempt.x1/y1 only ever equals acceptedRight/acceptedBottom when that
    // specific constraint was actually chosen for this attempt (the
    // "neither" fallback's clampedX1/clampedY1 can never coincidentally
    // match, since the accept condition above requires
    // acceptedRight < clampedX1 / acceptedBottom < clampedY1 strictly).
    return {
      left,
      top,
      width: safeWidth,
      height: safeHeight,
      appliedRightConstraint: attempt.x1 === acceptedRight ? acceptedRight : undefined,
      appliedBottomConstraint: attempt.y1 === acceptedBottom ? acceptedBottom : undefined,
    };
  }

  return null;
}

/**
 * Nudges an already-computed crop region as close as possible to
 * `targetRatio` (pure pixel width/height -- NOT a physical print-size
 * guarantee; see this engagement's own design notes), by EXPANDING the
 * narrower dimension outward -- this function never shrinks either
 * dimension of `region`, only grows one of them. This is the absolute
 * final geometric transformation in the applicant-photo crop pipeline,
 * applied after face-only expansion, layout-constraint narrowing, and
 * document-boundary clamping have all already run.
 *
 * Strict priority order, highest first:
 *   1. The detected face (`faceBox`) is never cut out of the result.
 *   2. The result never crosses `hardLeft/hardTop/hardRight/hardBottom` --
 *      the caller's own intersection of image bounds, document boundary
 *      (if any), and whichever layout constraints were ACTUALLY applied to
 *      produce `region` (see appliedRightConstraint/appliedBottomConstraint
 *      above) -- not merely offered.
 *   3. `region`'s own width/height are never shrunk below their current
 *      values, EXCEPT where that would conflict with priority 2 (see
 *      safeBaseW/safeBaseH below -- a no-op in the normal case, where the
 *      caller's hard bounds already contain `region` by construction).
 *   4. `targetRatio` is approached as closely as the above allow; it is
 *      never fully guaranteed.
 *
 * Returns `region` completely unchanged if any defensive invariant check
 * at the end fails (should be mathematically impossible by construction,
 * mirroring the same never-ship-a-broken-crop convention
 * detectDocumentBoundary.ts's own Formula A/C already uses) -- this
 * function's contract is "always a valid region", not merely "usually".
 */
export function applyTargetAspectRatio(
  region: PixelCropRegion,
  targetRatio: number,
  faceBox: PixelBox,
  hardLeft: number,
  hardTop: number,
  hardRight: number,
  hardBottom: number,
): PixelCropRegion {
  const availW = hardRight - hardLeft;
  const availH = hardBottom - hardTop;
  if (availW <= 0 || availH <= 0 || targetRatio <= 0) return region;

  // Priority 2 over priority 3: the "don't shrink below this" floor can
  // never itself exceed the hard bounds. A no-op whenever region already
  // fits inside [hardLeft,hardRight]x[hardTop,hardBottom], which holds by
  // construction in the normal case (see extractApplicantPhotoCrop.ts's
  // own hard-bounds computation) -- this only ever bites in the edge case
  // the caller's hard bounds were computed more tightly than `region`.
  const safeBaseW = Math.min(region.width, availW);
  const safeBaseH = Math.min(region.height, availH);
  const safeLeft = Math.min(Math.max(region.left, hardLeft), hardRight - safeBaseW);
  const safeTop = Math.min(Math.max(region.top, hardTop), hardBottom - safeBaseH);

  // Extra height (if width stays fixed at safeBaseW) is split top:bottom in
  // the SAME proportion as this module's own TOP_MARGIN_FACTOR/
  // BOTTOM_MARGIN_FACTOR, so growing the crop for aspect-ratio purposes
  // preserves the same headroom-above-vs-below-chin asymmetry as the base
  // face expansion, rather than introducing an unrelated 50/50 split.
  const topExpansionShare = TOP_MARGIN_FACTOR / (TOP_MARGIN_FACTOR + BOTTOM_MARGIN_FACTOR);

  const expandedByHeight = expandDimension(
    safeTop,
    safeBaseH,
    safeBaseW / targetRatio,
    hardTop,
    hardBottom,
    topExpansionShare,
  );
  const ratioByHeight = safeBaseW / expandedByHeight.extent;

  // Extra width (if height stays fixed at safeBaseH) is split 50/50 around
  // the face's own horizontal center is already implicit here: SIDE_MARGIN_FACTOR
  // is symmetric, so an even split keeps the face centered the same way the
  // base expansion already does.
  const expandedByWidth = expandDimension(safeLeft, safeBaseW, safeBaseH * targetRatio, hardLeft, hardRight, 0.5);
  const ratioByWidth = expandedByWidth.extent / safeBaseH;

  const chooseHeightExpansion = Math.abs(ratioByHeight - targetRatio) <= Math.abs(ratioByWidth - targetRatio);

  const candidate = chooseHeightExpansion
    ? { left: safeLeft, top: expandedByHeight.start, width: safeBaseW, height: expandedByHeight.extent }
    : { left: expandedByWidth.start, top: safeTop, width: expandedByWidth.extent, height: safeBaseH };

  // Round the EDGES (left, right, top, bottom), then derive width/height
  // from the rounded edges -- not the other way around. Rounding `left`
  // and `width` independently can drift the resulting right edge
  // (left+width) up to a full pixel away from the true left+width, because
  // two independent roundings can each move up to 0.5px in the same
  // direction. Rounding left/right (or top/bottom) directly means each
  // hard-bound edge only ever has ONE rounding decision made against it,
  // capping the worst-case deviation at the same 0.5px EPSILON the
  // defensive check below already assumes -- see
  // tests/visa.computeApplicantPhotoCropRegion.test.ts's own rounding
  // regression tests for a concrete fractional-hard-bound case this fixes.
  const roundedLeft = Math.round(candidate.left);
  const roundedTop = Math.round(candidate.top);
  const roundedRight = Math.round(candidate.left + candidate.width);
  const roundedBottom = Math.round(candidate.top + candidate.height);
  const result: PixelCropRegion = {
    left: roundedLeft,
    top: roundedTop,
    width: roundedRight - roundedLeft,
    height: roundedBottom - roundedTop,
  };

  // Defensive invariant check (mirrors detectDocumentBoundary.ts's own
  // Formula A/C "safe" check convention) -- should be mathematically
  // impossible to fail given the construction above, but this function's
  // contract is to never ship an invalid crop under any circumstance.
  const EPSILON = 0.5; // sub-pixel rounding tolerance only, not a real margin
  const withinHardBounds =
    result.left >= hardLeft - EPSILON &&
    result.top >= hardTop - EPSILON &&
    result.left + result.width <= hardRight + EPSILON &&
    result.top + result.height <= hardBottom + EPSILON;
  const faceContained =
    faceBox.x0 >= result.left - EPSILON &&
    faceBox.y0 >= result.top - EPSILON &&
    faceBox.x1 <= result.left + result.width + EPSILON &&
    faceBox.y1 <= result.top + result.height + EPSILON;

  if (!withinHardBounds || !faceContained || result.width < MIN_CROP_DIMENSION_PIXELS || result.height < MIN_CROP_DIMENSION_PIXELS) {
    return region;
  }

  return result;
}

/**
 * Grows a single axis's [start, start+extent) span to `desiredExtent` (never
 * below the current `extent` -- callers are responsible for that floor
 * already respecting `hardEnd - hardStart`), splitting the growth between
 * the start side and the end side per `startShareFraction`. If one side
 * can't absorb its full share without crossing its hard limit, the unused
 * portion shifts to the OTHER side instead of being dropped -- "shift, not
 * shrink" -- itself re-clamped to that side's own hard limit, so the result
 * never crosses hardStart/hardEnd regardless of how lopsided the available
 * room is.
 */
function expandDimension(
  start: number,
  extent: number,
  desiredExtent: number,
  hardStart: number,
  hardEnd: number,
  startShareFraction: number,
): { start: number; extent: number } {
  const availExtent = hardEnd - hardStart;
  const targetExtent = Math.min(Math.max(desiredExtent, extent), availExtent);
  const extra = targetExtent - extent;
  if (extra <= 0) return { start, extent };

  const availStart = start - hardStart;
  const availEnd = hardEnd - (start + extent);

  let extraStart = extra * startShareFraction;
  let extraEnd = extra - extraStart;

  if (extraStart > availStart) {
    const deficit = extraStart - availStart;
    extraStart = availStart;
    extraEnd = Math.min(extraEnd + deficit, availEnd);
  }
  if (extraEnd > availEnd) {
    const deficit = extraEnd - availEnd;
    extraEnd = availEnd;
    extraStart = Math.min(extraStart + deficit, availStart);
  }

  return { start: start - extraStart, extent: extent + extraStart + extraEnd };
}
