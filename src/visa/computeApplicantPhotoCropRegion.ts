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
const TOP_MARGIN_FACTOR = 0.9;
const BOTTOM_MARGIN_FACTOR = 0.7;
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
  const minFaceRightPadding = Math.max(8, 0.05 * faceWidth);
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

    return { left, top, width: safeWidth, height: safeHeight };
  }

  return null;
}
