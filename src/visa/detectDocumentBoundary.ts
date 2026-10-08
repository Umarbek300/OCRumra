/**
 * Loose geometry shapes, deliberately duplicated rather than imported --
 * same "loose/local shape" convention as detectPersonalDataColumn.ts and
 * computeApplicantPhotoCropRegion.ts -- so this module stays trivially
 * unit-testable with plain object fixtures and has no dependency on any
 * other visa/ocr module's internals.
 */
export interface BoundaryParagraph {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface FaceBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Structurally compatible with computeApplicantPhotoCropRegion.ts's VisionFaceAnnotation -- duck-typed, not imported, to avoid a dependency cycle. */
export interface LooseFaceAnnotation {
  boundingPoly?: { vertices?: ({ x?: number | null; y?: number | null } | null)[] | null } | null;
  detectionConfidence?: number | null;
}

export type DocumentBoundaryConfidence = 'HIGH' | 'MEDIUM' | 'LOW';

export interface DocumentBoundaryResult {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  confidence: DocumentBoundaryConfidence;
  /** Fraction of the full image area this boundary covers -- diagnostic/debug value, not used in any decision outside this module. */
  coverageFraction: number;
}

const MIN_TEXT_LENGTH = 2;
// The union of all real text + the face sits strictly inside the printed
// passport page (there's always a blank/background margin around the
// outermost printed line and the photo itself), so the raw union is
// expanded outward by this fraction of each image dimension before being
// used as the boundary -- a deliberately generous allowance, not a
// measured standard (see this module's own doc comment on calibration).
const BOUNDARY_MARGIN_FRACTION = 0.04;
const MIN_PARAGRAPHS_FOR_BOUNDARY = 4;
/**
 * If the union (post-margin) already covers this much of the frame, the
 * passport is treated as already filling the photo (the common case: no
 * meaningful background to exclude) -- returning null here is a
 * deliberate no-op, not a failure, and callers must treat it exactly like
 * "no boundary constraint available".
 */
const TRIVIAL_COVERAGE_THRESHOLD = 0.92;
/**
 * A union this small relative to the full frame is more likely a
 * detection artifact (e.g. only a couple of stray words found) than a
 * genuine tight passport-in-a-large-background photo -- distrust it
 * rather than risk cropping away the real document.
 */
const MIN_MEANINGFUL_COVERAGE = 0.12;
const HIGH_CONFIDENCE_MIN_PARAGRAPHS = 8;
const HIGH_CONFIDENCE_MIN_COVERAGE = 0.3;
/** How far (as a multiple of the text union's own width/height) a face may sit from the text cluster and still be treated as part of the same document -- see detectDocumentBoundary's own loop comment. */
const FACE_PROXIMITY_MARGIN_FACTOR = 0.5;

function faceBoxOf(face: LooseFaceAnnotation): FaceBox | null {
  const vertices = face.boundingPoly?.vertices;
  if (!vertices || vertices.length === 0) return null;
  const xs = vertices.map((v) => v?.x ?? 0);
  const ys = vertices.map((v) => v?.y ?? 0);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

function boxCenter(box: FaceBox): { x: number; y: number } {
  return { x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2 };
}

function centerInsideBoundary(box: FaceBox, boundary: FaceBox): boolean {
  const c = boxCenter(box);
  return c.x >= boundary.x0 && c.x <= boundary.x1 && c.y >= boundary.y0 && c.y <= boundary.y1;
}

/**
 * Pulls a margin-expanded MAX-side edge (right or bottom) back toward an
 * excluded face's own near edge, when that face's box overlaps the margin
 * zone (contentMax, rawMax] -- but never past contentMax itself, so the
 * real text/kept-face union is never cut. A face that doesn't reach into
 * the zone at all (or is already fully beyond rawMax) leaves the edge
 * unchanged. `excludedBoxesOnAxis` is each excluded face's own [near, far]
 * extent on this SAME axis (near = the edge closest to the content, e.g.
 * face.x0 for a right-edge check; far = face.x1).
 */
function safeMaxEdge(
  contentMax: number,
  rawMax: number,
  excludedBoxesOnAxis: ReadonlyArray<readonly [near: number, far: number]>,
): number {
  let edge = rawMax;
  for (const [near, far] of excludedBoxesOnAxis) {
    if (near >= rawMax || far <= contentMax) continue; // no overlap with the margin zone
    edge = Math.min(edge, Math.max(contentMax, near));
  }
  return Math.max(edge, contentMax);
}

/** MIN-side (left/top) mirror of safeMaxEdge -- near/far are swapped (near = the face edge closest to the content, e.g. face.x1 for a left-edge check; far = face.x0). */
function safeMinEdge(
  contentMin: number,
  rawMin: number,
  excludedBoxesOnAxis: ReadonlyArray<readonly [near: number, far: number]>,
): number {
  let edge = rawMin;
  for (const [near, far] of excludedBoxesOnAxis) {
    if (near <= rawMin || far >= contentMin) continue; // no overlap with the margin zone
    edge = Math.max(edge, Math.min(contentMin, near));
  }
  return Math.min(edge, contentMin);
}

/**
 * Approximates the printed passport page's own extent within a Telegram
 * photo that may show surrounding background (a table, a hand holding the
 * document, etc.) -- NOT a true document-edge/contour detector and NOT a
 * perspective/homography rectifier. This codebase has no computer-vision
 * library capable of edge detection, contour-fitting or a homography warp
 * (only `sharp`, which crops/resizes/rotates but does not find document
 * edges, and `@google-cloud/vision`, whose only relevant signal here is
 * the SAME text/face geometry already fetched for OCR). Adding a true CV
 * pipeline (e.g. via a native OpenCV binding) was deliberately rejected
 * for this pass: a new native dependency in a long-running production
 * worker is a real stability/build risk this engagement has consistently
 * avoided, and a from-scratch pure-JS edge/contour/homography
 * implementation could not be validated against enough real passports in
 * one pass to trust in production.
 *
 * What this DOES do, using only data already fetched at zero extra Vision
 * API cost: takes the union bounding box of every real text paragraph
 * (already-flattened, EXIF-normalized geometry -- see
 * transformVisionCoordinates.ts) plus every detected face, expands it by a
 * small margin, and treats that as the document's approximate extent. On
 * a passport-filling photo this union naturally covers nearly the whole
 * frame (returns null -- no-op). On a photo with real background, the
 * union excludes the background (since background rarely carries OCR'd
 * text or a detected face) -- this is the mechanism that lets background
 * and hand-held photos be handled without true document-edge detection.
 * It does NOT straighten a tilted/rotated passport -- the returned box is
 * always axis-aligned in the image's own (already EXIF-normalized)
 * coordinate frame, so a perspective-distorted photo is only region-
 * isolated, never dewarped. This limitation must be reported, not hidden,
 * whenever this module's behavior is described.
 *
 * Returns null -- never a guessed boundary -- when: too few real
 * paragraphs exist to trust a union at all, the resulting coverage is
 * implausibly small (likely a detection artifact), or the coverage is
 * already large enough that there is no meaningful background to exclude.
 */
export function detectDocumentBoundary(
  paragraphs: readonly BoundaryParagraph[],
  faces: readonly LooseFaceAnnotation[],
  imageWidth: number,
  imageHeight: number,
): DocumentBoundaryResult | null {
  if (imageWidth <= 0 || imageHeight <= 0) return null;

  const realParagraphs = paragraphs.filter((p) => p.text.trim().length >= MIN_TEXT_LENGTH);
  if (realParagraphs.length < MIN_PARAGRAPHS_FOR_BOUNDARY) return null;

  // Text-only union FIRST -- the printed text is the most reliable signal
  // for "this is where the document is". Computed separately from the
  // face union below on purpose (see the loop's own comment).
  const textX0 = Math.min(...realParagraphs.map((p) => p.x0));
  const textY0 = Math.min(...realParagraphs.map((p) => p.y0));
  const textX1 = Math.max(...realParagraphs.map((p) => p.x1));
  const textY1 = Math.max(...realParagraphs.map((p) => p.y1));

  let x0 = textX0;
  let y0 = textY0;
  let x1 = textX1;
  let y1 = textY1;

  // Only union a face INTO the boundary when it sits reasonably close to
  // the text cluster already -- never unconditionally. A hand-holder's
  // own face in a hand-held photo can be anywhere in the frame, often far
  // from the passport's printed text; unioning it in regardless would
  // stretch the boundary to cover BOTH the document and the holder's
  // face, defeating the whole point of later filtering that face out (see
  // filterFacesToBoundary) -- the filter can only exclude a face that
  // ends up OUTSIDE the boundary. A genuine passport photo, by contrast,
  // always sits immediately beside/overlapping the personal-data text
  // column on a real passport, so this proximity check reliably includes
  // it while excluding a distant, unrelated face.
  const proximityMarginX = FACE_PROXIMITY_MARGIN_FACTOR * Math.max(1, textX1 - textX0);
  const proximityMarginY = FACE_PROXIMITY_MARGIN_FACTOR * Math.max(1, textY1 - textY0);
  // Excluded faces' own boxes are kept (not just dropped) so the margin
  // step below can pull back from one, rather than risk the fixed
  // percentage margin reaching into a face this function already decided
  // is unrelated to the document -- see safeMaxEdge/safeMinEdge.
  const excludedFaceBoxes: FaceBox[] = [];
  // Faces that pass the proximity window above are only PROVISIONALLY
  // included -- collected here first rather than unioned in immediately,
  // so that when two or more pass the SAME window at once (e.g. a
  // passport held in a hand, where both the applicant's printed photo and
  // the holder's own face can sit close enough to the text cluster to
  // both qualify), a relative tie-break can run before anything is
  // unioned. This never changes anything when 0 or 1 face passes the
  // window, which is true for the overwhelming majority of real photos.
  const includedCandidates: FaceBox[] = [];
  for (const face of faces) {
    const box = faceBoxOf(face);
    if (!box) continue;
    const center = boxCenter(box);
    const nearText =
      center.x >= textX0 - proximityMarginX &&
      center.x <= textX1 + proximityMarginX &&
      center.y >= textY0 - proximityMarginY &&
      center.y <= textY1 + proximityMarginY;
    if (!nearText) {
      excludedFaceBoxes.push(box);
      continue;
    }
    includedCandidates.push(box);
  }

  let boxesToUnion: readonly FaceBox[];
  if (includedCandidates.length <= 1) {
    // 0 or 1 candidate -- nothing to break a tie between; identical to the
    // pre-tie-break behavior.
    boxesToUnion = includedCandidates;
  } else {
    // 2+ faces passed the SAME proximity window at once. Rank them by how
    // far their own center sits from the text union's bounding box (0 when
    // the center falls inside it) -- a genuine passport photo's face
    // typically sits inside or right at the edge of the personal-data text
    // block, while an unrelated nearby face (e.g. a hand-holder's) tends to
    // sit further from the text itself even when it's still within the
    // proximity margin. This reuses geometry already computed above (no
    // new data, no new absolute threshold) and is a pure relative
    // comparison among this call's own candidates.
    const scored = includedCandidates.map((box) => {
      const center = boxCenter(box);
      const excessX = Math.max(0, textX0 - center.x, center.x - textX1);
      const excessY = Math.max(0, textY0 - center.y, center.y - textY1);
      return { box, score: Math.hypot(excessX, excessY) };
    });
    const minScore = Math.min(...scored.map((s) => s.score));
    const winners = scored.filter((s) => s.score === minScore);
    const winner = winners[0];
    if (winners.length === 1 && winner) {
      boxesToUnion = [winner.box];
      for (const s of scored) {
        if (s.box !== winner.box) excludedFaceBoxes.push(s.box);
      }
    } else {
      // Exact tie (including the fully-ambiguous case where every
      // candidate scores the same, e.g. all centers fall inside the text
      // union) -- never invent a new tie-break signal here. Fall back to
      // the original behavior: union every tied candidate in, and do not
      // treat any of them as excluded.
      boxesToUnion = includedCandidates;
    }
  }

  for (const box of boxesToUnion) {
    x0 = Math.min(x0, box.x0);
    y0 = Math.min(y0, box.y0);
    x1 = Math.max(x1, box.x1);
    y1 = Math.max(y1, box.y1);
  }

  // The real content floor/ceiling for the tightening step below is this
  // union (text + every INCLUDED face), not the pure text-only union above
  // -- an included face (the passport's own photo) can legitimately extend
  // past the text's own bounds, and the tightening step must never cut
  // into it just because some OTHER, excluded face triggered a pull-back
  // on that same side.
  const contentX0 = x0;
  const contentY0 = y0;
  const contentX1 = x1;
  const contentY1 = y1;

  const marginX = BOUNDARY_MARGIN_FRACTION * imageWidth;
  const marginY = BOUNDARY_MARGIN_FRACTION * imageHeight;
  x0 = Math.max(0, x0 - marginX);
  y0 = Math.max(0, y0 - marginY);
  x1 = Math.min(imageWidth, x1 + marginX);
  y1 = Math.min(imageHeight, y1 + marginY);

  // Tighten the margin, on whichever side(s) it reaches into an excluded
  // face's own box -- never below/above the real content union (text +
  // every included face) itself. A candidate that somehow still failed
  // that (it never has, in synthetic or real-data validation) is rejected
  // outright: the untightened margin computed above is kept rather than
  // risk an unsafe crop.
  if (excludedFaceBoxes.length > 0) {
    const candidateX0 = safeMinEdge(contentX0, x0, excludedFaceBoxes.map((b) => [b.x1, b.x0] as const));
    const candidateX1 = safeMaxEdge(contentX1, x1, excludedFaceBoxes.map((b) => [b.x0, b.x1] as const));
    const candidateY0 = safeMinEdge(contentY0, y0, excludedFaceBoxes.map((b) => [b.y1, b.y0] as const));
    const candidateY1 = safeMaxEdge(contentY1, y1, excludedFaceBoxes.map((b) => [b.y0, b.y1] as const));
    const safe =
      candidateX0 >= x0 && candidateX0 <= contentX0 &&
      candidateX1 <= x1 && candidateX1 >= contentX1 &&
      candidateY0 >= y0 && candidateY0 <= contentY0 &&
      candidateY1 <= y1 && candidateY1 >= contentY1;
    if (safe) {
      x0 = candidateX0;
      y0 = candidateY0;
      x1 = candidateX1;
      y1 = candidateY1;
    }
  }

  if (x1 <= x0 || y1 <= y0) return null;

  const coverageFraction = ((x1 - x0) * (y1 - y0)) / (imageWidth * imageHeight);
  if (coverageFraction >= TRIVIAL_COVERAGE_THRESHOLD) return null;
  if (coverageFraction < MIN_MEANINGFUL_COVERAGE) return null;

  const confidence: DocumentBoundaryConfidence =
    realParagraphs.length >= HIGH_CONFIDENCE_MIN_PARAGRAPHS && coverageFraction >= HIGH_CONFIDENCE_MIN_COVERAGE
      ? 'HIGH'
      : 'MEDIUM';

  return { x0, y0, x1, y1, confidence, coverageFraction };
}

/**
 * Keeps only the paragraphs whose CENTER falls inside the detected
 * boundary -- a center check (not full-containment) so a paragraph that
 * legitimately starts right at the boundary's own edge (it contributed to
 * computing that edge in the first place) is never spuriously excluded by
 * its own rounding.
 */
export function filterParagraphsToBoundary<T extends BoundaryParagraph>(
  paragraphs: readonly T[],
  boundary: FaceBox,
): T[] {
  return paragraphs.filter((p) => centerInsideBoundary(p, boundary));
}

/**
 * Keeps only the detected faces whose center falls inside the document
 * boundary -- guards against a hand-held photo where the person's own
 * face (not the passport's printed photo) is large and confident enough
 * to otherwise win computeApplicantPhotoCropRegion's own "largest
 * confident face" selection. Never returns an empty list: if filtering
 * would remove every candidate (e.g. the boundary detection itself is
 * slightly off), the ORIGINAL, unfiltered list is returned instead --
 * this function's only job is to narrow the candidate set when it can do
 * so safely, never to produce "no face found" on its own.
 */
export function filterFacesToBoundary<T extends LooseFaceAnnotation>(
  faces: readonly T[],
  boundary: FaceBox,
): T[] {
  const inside = faces.filter((face) => {
    const box = faceBoxOf(face);
    return box ? centerInsideBoundary(box, boundary) : false;
  });
  return inside.length > 0 ? inside : [...faces];
}

export interface ClampableRegion {
  left: number;
  top: number;
  width: number;
  height: number;
}

const MIN_CLAMPED_DIMENSION_PIXELS = 80;

/**
 * Final safety clamp: pulls a computed crop region's edges inward to the
 * document boundary when the region extends beyond it -- e.g. the
 * face-based expansion margins reached past the passport's own edge into
 * background. Only ever shrinks, never grows, the input region. Rejects
 * the clamp (returns the ORIGINAL, unclamped region unchanged) if doing so
 * would either violate face containment or shrink the crop below the same
 * minimum dimension floor computeApplicantPhotoCropRegion.ts itself
 * enforces -- this function deliberately duplicates that floor rather
 * than importing it, keeping computeApplicantPhotoCropRegion.ts's own
 * code completely untouched (see this feature's own design notes on why
 * that module was not modified for this feature).
 */
export function clampRegionToBoundary(
  region: ClampableRegion,
  boundary: FaceBox,
  face: FaceBox,
): ClampableRegion {
  const left = Math.max(region.left, Math.floor(boundary.x0));
  const top = Math.max(region.top, Math.floor(boundary.y0));
  const right = Math.min(region.left + region.width, Math.ceil(boundary.x1));
  const bottom = Math.min(region.top + region.height, Math.ceil(boundary.y1));
  const width = right - left;
  const height = bottom - top;

  if (width < MIN_CLAMPED_DIMENSION_PIXELS || height < MIN_CLAMPED_DIMENSION_PIXELS) return region;

  const faceContained = face.x0 >= left && face.y0 >= top && face.x1 <= right && face.y1 <= bottom;
  if (!faceContained) return region;

  return { left, top, width, height };
}
