import sharp from 'sharp';
import { getImageDimensions } from '../ocr/mrz/getImageDimensions.js';
import { locateMrzParagraphGeometry } from '../ocr/mrz/locateMrzParagraphGeometry.js';
import type { VisionPage } from '../ocr/visual/extractIssueDateFromVisionStructure.js';
import {
  applyTargetAspectRatio,
  computeApplicantPhotoCropRegion,
  selectBestFaceBox,
  type LayoutConstraints,
  type PixelBox,
  type PixelCropRegion,
  type VisionFaceAnnotation,
} from './computeApplicantPhotoCropRegion.js';
import { detectFacesReal, type DetectFacesFn, type DetectFacesResult } from './detectApplicantFaces.js';
import { detectPersonalDataColumn } from './detectPersonalDataColumn.js';
import {
  clampRegionToBoundary,
  detectDocumentBoundary,
  filterFacesToBoundary,
  filterParagraphsToBoundary,
  type DocumentBoundaryResult,
} from './detectDocumentBoundary.js';
import { flattenParagraphsToNormalizedSpace, type NormalizedParagraph, type RawImageGeometry } from './transformVisionCoordinates.js';

const MAX_ERROR_MESSAGE_LENGTH = 300;

export type { DetectFacesResult, DetectFacesFn };

export interface ExtractApplicantPhotoCropDependencies {
  detectFaces: DetectFacesFn;
}

/** Bounded the same way googleVisionProvider.ts bounds its own Vision error messages -- defense in depth. */
function sanitizeErrorReason(error: unknown): string {
  const message = error instanceof Error ? error.message : 'unknown error';
  return message.slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

const defaultDependencies: ExtractApplicantPhotoCropDependencies = {
  detectFaces: detectFacesReal,
};

async function encodeCrop(imageBuffer: Buffer, region: PixelCropRegion, mimeType: string): Promise<Buffer> {
  const pipeline = sharp(imageBuffer).extract(region);
  if (mimeType === 'image/png') return pipeline.png().toBuffer();
  if (mimeType === 'image/webp') return pipeline.webp({ quality: 92 }).toBuffer();
  // Telegram photos are JPEG in the overwhelming common case; any other/
  // unrecognized mime type also falls back to JPEG here, matching
  // uploadApplicantPhoto.ts's own extensionForMimeType default.
  return pipeline.jpeg({ quality: 92 }).toBuffer();
}

const RIGHT_MARGIN_FRACTION = 0.012;
const BOTTOM_MARGIN_FRACTION = 0.012;
const MIN_MARGIN_PIXELS = 8;

// The applicant-photo crop's own output margins (TOP_MARGIN_FACTOR /
// BOTTOM_MARGIN_FACTOR in computeApplicantPhotoCropRegion.ts) are tuned
// independently of, and can change independently of, the search window
// personal-data-column detection uses -- these fixed, legacy-style factors
// (matching that module's pre-retune values) give detectPersonalDataColumn
// a stable context region that never shifts just because the final crop's
// own margins were retuned. This decoupling fixes a real regression: a
// smaller TOP/BOTTOM margin was shrinking the Y-extent fed into
// detectPersonalDataColumn, which could knock its confidence below HIGH
// and silently drop the RIGHT constraint it would otherwise have supplied.
const COLUMN_DETECTION_CONTEXT_TOP_FACTOR = 0.9;
const COLUMN_DETECTION_CONTEXT_BOTTOM_FACTOR = 0.7;
const COLUMN_DETECTION_CONTEXT_SIDE_FACTOR = 0.55;

/**
 * The fixed search-window region fed to detectPersonalDataColumn --
 * deliberately NOT derived from the final crop region (see the module-level
 * comment on COLUMN_DETECTION_CONTEXT_* above), so it stays byte-identical
 * regardless of how computeApplicantPhotoCropRegion.ts's own output margins
 * are tuned.
 */
export function buildColumnDetectionContext(faceBox: PixelBox): PixelBox {
  const faceWidth = faceBox.x1 - faceBox.x0;
  const faceHeight = faceBox.y1 - faceBox.y0;
  return {
    x0: faceBox.x0 - faceWidth * COLUMN_DETECTION_CONTEXT_SIDE_FACTOR,
    x1: faceBox.x1 + faceWidth * COLUMN_DETECTION_CONTEXT_SIDE_FACTOR,
    y0: faceBox.y0 - faceHeight * COLUMN_DETECTION_CONTEXT_TOP_FACTOR,
    y1: faceBox.y1 + faceHeight * COLUMN_DETECTION_CONTEXT_BOTTOM_FACTOR,
  };
}

/**
 * Builds the optional layout-aware crop constraints (personal-data column
 * -> right boundary, MRZ -> bottom boundary) from already-flattened,
 * EXIF-normalized paragraph geometry (see flattenParagraphsToNormalizedSpace
 * / detectDocumentBoundary.ts's own optional pre-filtering of that same
 * list) -- no Vision API call of its own, pure and synchronous. Returns
 * undefined when the column signal is below MEDIUM confidence AND the MRZ
 * signal is below HIGH confidence, which is exactly "fall back to the pure
 * face-only crop", never a guess.
 *
 * The column/RIGHT side also acts on MEDIUM confidence, using the EXACT
 * SAME margin formula as HIGH (no extra buffer) -- real passports 408/409/
 * 410 were MEDIUM before detectPersonalDataColumn.ts's own
 * DISPERSION_BAD_FRACTION recalibration (see that module's doc comment),
 * yet were genuine columns, not noise, so MEDIUM is worth acting on. No
 * new margin was introduced here: computeApplicantPhotoCropRegion.ts's own
 * acceptance check (`right >= box.x1 + minFaceRightPadding`) is the ONLY
 * thing that decides whether a given `right` value is safe, and it takes
 * no confidence parameter at all -- it is exactly as strict for a
 * MEDIUM-sourced value as for a HIGH-sourced one. Real passport 414 (the
 * only real MEDIUM example on record, gap=19px, tighter than every other
 * real sample at 30-56px) is REJECTED by that exact check even with this
 * identical margin (274.25 < 266+8.9), falling back to the face-only
 * region -- proving the check's protection does not weaken for MEDIUM.
 * The MRZ/BOTTOM side deliberately never acts on MEDIUM or LOW:
 * locateMrzParagraphGeometry.ts's MEDIUM tier has a confirmed
 * false-positive mode (see tests/mrz.locateMrzParagraphGeometry.test.ts --
 * an ordinary printed sentence can reach MEDIUM from shape heuristics
 * alone, with neither a "P<" prefix nor a long MRZ-alphabet run), so
 * acting on it would mean clamping the crop's bottom edge to an
 * essentially arbitrary position found by a known-unreliable detector.
 */
function buildLayoutConstraintsFromParagraphs(
  paragraphs: readonly NormalizedParagraph[],
  faceBox: PixelBox,
  normalizedWidth: number,
  normalizedHeight: number,
): LayoutConstraints | undefined {
  if (paragraphs.length === 0) return undefined;

  const expandedFaceRegion = buildColumnDetectionContext(faceBox);

  const mrzResult = locateMrzParagraphGeometry(paragraphs, normalizedWidth, normalizedHeight);
  const mrzParagraphs = mrzResult ? [mrzResult.paragraph] : [];

  const columnResult = detectPersonalDataColumn(
    paragraphs,
    faceBox,
    expandedFaceRegion,
    normalizedWidth,
    normalizedHeight,
    mrzParagraphs,
  );

  const constraints: LayoutConstraints = {};
  if (columnResult && (columnResult.confidence === 'HIGH' || columnResult.confidence === 'MEDIUM')) {
    const margin = Math.max(MIN_MARGIN_PIXELS, RIGHT_MARGIN_FRACTION * normalizedWidth);
    constraints.right = columnResult.columnX0 - margin;
  }
  // mrzResult: HIGH only -- MEDIUM/LOW MRZ confidence is deliberately never
  // used (see this function's own doc comment above for why).
  if (mrzResult && mrzResult.confidence === 'HIGH') {
    const margin = Math.max(MIN_MARGIN_PIXELS, BOTTOM_MARGIN_FRACTION * normalizedHeight);
    constraints.bottom = mrzResult.top - margin;
  }

  if (constraints.right === undefined && constraints.bottom === undefined) return undefined;
  return constraints;
}

/**
 * Crops the applicant's printed passport PHOTO (the full portrait
 * rectangle, not just a tight face box -- see computeApplicantPhotoCropRegion)
 * out of the original Telegram passport image. The ORIGINAL full-page
 * buffer is used only as an in-memory input here and is never itself
 * returned or uploaded -- only this function's cropped output is ever
 * passed to uploadApplicantPhoto by its caller.
 *
 * The input buffer is first EXIF-auto-oriented (sharp's rotate() with no
 * arguments physically applies the EXIF orientation tag and strips it) so
 * that the pixel coordinates Vision's FACE_DETECTION returns and the pixel
 * grid sharp's extract() crops from are always the exact same coordinate
 * space, regardless of how the original photo's camera/Telegram client
 * recorded orientation -- this is done unconditionally so there's no
 * reliance on assumptions about whether Vision itself also auto-rotates by
 * EXIF internally. This normalization is local to this crop path only; it
 * does not change the buffer passed to the configured OcrProvider's own
 * extract() call (see performPassportOcr.ts), so MRZ/text extraction is
 * entirely unaffected.
 *
 * Returns null (never throws for this case) when no reliably-located photo
 * region can be determined -- callers must treat that exactly like "photo
 * storage not configured": skip uploading anything for this message, never
 * fall back to uploading the original, uncropped passport image.
 *
 * DOES throw for a genuine Vision API infrastructure failure (network,
 * quota, auth) -- same distinction googleVisionProvider.ts's own MRZ call
 * makes -- so callers that want OCR to still succeed despite a photo
 * problem (see performPassportOcr.ts) must wrap this call in their own
 * try/catch, exactly as they already do around uploadApplicantPhoto.
 *
 * `textDetectionPages` is optional and additive: when provided (the
 * google-vision provider threads its own already-computed
 * DOCUMENT_TEXT_DETECTION `pages` through from performPassportOcr.ts, at
 * zero extra Vision API cost), the crop is additionally constrained to
 * stop short of the passport's printed personal-data text column and MRZ
 * band (see buildLayoutConstraintsFromParagraphs above) -- but ONLY when
 * that detection independently reaches HIGH confidence AND keeps the
 * detected face safely contained; otherwise, or when this parameter is
 * omitted entirely (every other OCR provider, and every existing
 * caller/test), this function's behavior is exactly the original pure
 * face-only crop.
 *
 * Also from the SAME `textDetectionPages`, at zero extra Vision API cost:
 * an approximate document-boundary check (see detectDocumentBoundary.ts)
 * that narrows face selection and clamps the final crop to the passport's
 * own detected extent when the photo shows meaningful surrounding
 * background or is held in a hand -- a bounding-box isolation, NOT a true
 * document-edge/perspective-rectification step (this codebase has no
 * computer-vision library capable of that; see detectDocumentBoundary.ts's
 * own doc comment). When no such background is detected, or detection is
 * not confident enough, this step is a complete no-op and behavior is
 * identical to not having it at all.
 */
export async function extractApplicantPhotoCrop(
  imageBuffer: Buffer,
  mimeType: string,
  deps: ExtractApplicantPhotoCropDependencies = defaultDependencies,
  textDetectionPages?: readonly VisionPage[],
  precomputedFaces?: readonly VisionFaceAnnotation[],
): Promise<Buffer | null> {
  const normalizedBuffer = await sharp(imageBuffer).rotate().toBuffer();

  // `precomputedFaces` is optional and purely additive: when the caller
  // already made its own Vision FACE_DETECTION call on this SAME
  // EXIF-normalized buffer for another purpose (performPassportOcr.ts
  // shares one such call with buildCanonicalPassportImage.ts, to avoid a
  // second Vision API call per message), it is reused here verbatim and
  // deps.detectFaces is never invoked. Omitted (every existing caller/test)
  // -> behavior is byte-identical to before this parameter existed.
  let faces: VisionFaceAnnotation[];
  if (precomputedFaces) {
    faces = [...precomputedFaces];
  } else {
    try {
      ({ faces } = await deps.detectFaces(normalizedBuffer));
    } catch (error) {
      const reason = sanitizeErrorReason(error);
      console.log(`[applicant-photo-crop] Vision face detection call failed: ${reason}`);
      throw new Error(`Google Vision face detection call failed: ${reason}`);
    }
  }

  const { width, height } = await getImageDimensions(normalizedBuffer);

  // --- document boundary (optional, additive -- see detectDocumentBoundary.ts) ---
  let documentBoundary: ReturnType<typeof detectDocumentBoundary> = null;
  let normalizedParagraphs: NormalizedParagraph[] = [];
  let effectiveFaces = faces;

  if (textDetectionPages && textDetectionPages.length > 0) {
    try {
      const rawMeta = await sharp(imageBuffer).metadata();
      const rawWidth = rawMeta.width ?? 0;
      const rawHeight = rawMeta.height ?? 0;
      if (rawWidth > 0 && rawHeight > 0) {
        const geometry: RawImageGeometry = { rawWidth, rawHeight, orientation: rawMeta.orientation };
        normalizedParagraphs = flattenParagraphsToNormalizedSpace(textDetectionPages, geometry);
        documentBoundary = detectDocumentBoundary(normalizedParagraphs, faces, width, height);
        if (documentBoundary) {
          effectiveFaces = filterFacesToBoundary(faces, documentBoundary);
        }
      }
    } catch (error) {
      // Document boundary detection is a pure quality enhancement -- it
      // must never block or fail the portrait pipeline. Falls back to the
      // unfiltered face list exactly as if no boundary had been detected.
      console.log(
        `[applicant-photo-crop] document boundary detection failed, proceeding without it: ${sanitizeErrorReason(error)}`,
      );
      documentBoundary = null;
      effectiveFaces = faces;
    }
  }

  const baseRegion = computeApplicantPhotoCropRegion(effectiveFaces, width, height);
  if (!baseRegion) {
    console.log('[applicant-photo-crop] no reliable photo region found; skipping photo for this message');
    return null;
  }

  let region = baseRegion;
  if (normalizedParagraphs.length > 0) {
    const faceBox = selectBestFaceBox(effectiveFaces);
    if (faceBox) {
      try {
        const paragraphsForLayout = documentBoundary
          ? filterParagraphsToBoundary(normalizedParagraphs, documentBoundary)
          : normalizedParagraphs;
        const layoutConstraints = buildLayoutConstraintsFromParagraphs(paragraphsForLayout, faceBox, width, height);
        if (layoutConstraints) {
          const constrainedRegion = computeApplicantPhotoCropRegion(effectiveFaces, width, height, layoutConstraints);
          if (constrainedRegion) region = constrainedRegion;
        }
      } catch (error) {
        // Layout detection is a pure quality enhancement -- it must never
        // block or fail the portrait pipeline. Any unexpected error here
        // (malformed pages data, etc.) falls back to the base face-only
        // region computed above, exactly as if no layout data existed.
        console.log(
          `[applicant-photo-crop] layout-aware constraint detection failed, using face-only crop: ${sanitizeErrorReason(error)}`,
        );
      }
    }
  }

  if (documentBoundary) {
    try {
      const faceBox = selectBestFaceBox(effectiveFaces);
      if (faceBox) {
        // clampRegionToBoundary (detectDocumentBoundary.ts) returns a fresh
        // {left,top,width,height} object with no knowledge of
        // appliedRightConstraint/appliedBottomConstraint -- that module is
        // deliberately left untouched (see its own doc comment), so those
        // fields are preserved across the clamp here instead.
        const { appliedRightConstraint, appliedBottomConstraint } = region;
        region = { ...clampRegionToBoundary(region, documentBoundary, faceBox), appliedRightConstraint, appliedBottomConstraint };
      }
    } catch (error) {
      console.log(
        `[applicant-photo-crop] document boundary clamp failed, using unclamped region: ${sanitizeErrorReason(error)}`,
      );
    }
  }

  try {
    const faceBox = selectBestFaceBox(effectiveFaces);
    if (faceBox) {
      const hardBounds = computeHardBounds(region, baseRegion, width, height, documentBoundary, normalizedParagraphs);
      region = applyTargetAspectRatio(
        region,
        TARGET_ASPECT_RATIO,
        faceBox,
        hardBounds.hardLeft,
        hardBounds.hardTop,
        hardBounds.hardRight,
        hardBounds.hardBottom,
      );
    }
  } catch (error) {
    console.log(
      `[applicant-photo-crop] target aspect-ratio step failed, using region as computed so far: ${sanitizeErrorReason(error)}`,
    );
  }

  return encodeCrop(normalizedBuffer, region, mimeType);
}

/**
 * The target pixel width/height ratio applyTargetAspectRatio nudges the
 * final crop toward -- a pure pixel ratio contract only (see that
 * function's own doc comment), NOT a physical print-size (e.g. 35x45mm)
 * guarantee.
 */
const TARGET_ASPECT_RATIO = 0.78;

/**
 * Minimal left/top/width/height shape of the pre-narrowing, pre-clamp
 * face-only region (computeApplicantPhotoCropRegion's own output BEFORE any
 * right/bottom layout narrowing or document-boundary clamp) -- the
 * "already deemed safe by construction" reference rectangle the four
 * occupancy checks below cap growth back to.
 */
type BaseRegionEdges = Pick<PixelCropRegion, 'left' | 'top' | 'width' | 'height'>;

/**
 * The maximal rectangle applyTargetAspectRatio is allowed to grow `region`
 * into: the image bounds intersected with the document boundary (if
 * present) and whichever layout constraint(s) were ACTUALLY applied to
 * `region` -- each only included if `region` already respects it. A
 * constraint `region` does NOT currently respect (e.g. clampRegionToBoundary
 * above declined to clamp, to protect face containment) was not actually
 * applied, so imposing it here would wrongly force safeBaseW/safeBaseH in
 * applyTargetAspectRatio to shrink `region`, violating that function's own
 * "never shrink in the normal case" contract -- excluding it instead just
 * falls back to the image bounds for that edge, exactly as if detection
 * had found nothing there.
 *
 * PER-AXIS EXPANSION SAFETY CHECK: each of `hardTop`/`hardRight`/
 * `hardBottom`/`hardLeft` as computed above can sit well beyond
 * `baseRegion`'s own corresponding edge (the face-only crop's edges, BEFORE
 * any right/bottom layout narrowing or document-boundary clamp), since
 * documentBoundary is the whole PAGE's own boundary, not specifically aware
 * of text sitting just outside the printed photo -- and when no
 * documentBoundary exists at all (or no layout constraint was applied),
 * each hard bound defaults to the image's own edge, an even looser bound.
 * If ANY detected paragraph (from `paragraphs`, in the SAME normalized
 * coordinate space as `region` -- regardless of its text content, length,
 * or shape) falls inside the gap between a hard bound and `baseRegion`'s
 * corresponding edge, AND overlaps `region`'s own CURRENT span on the
 * PERPENDICULAR axis (region.left/width for TOP/BOTTOM, region.top/height
 * for RIGHT/LEFT -- at this point in the pipeline unaffected by
 * narrowing/clamp in the normal case, so effectively the same span
 * `baseRegion` itself had), that gap is no longer assumed safe to expand
 * into: the hard bound is pulled in to `baseRegion`'s own edge, so
 * applyTargetAspectRatio's own expandDimension (which already never
 * crosses whatever hard bound it is given) simply cannot grow past the
 * face-only region's existing edge on that axis for this crop. This is a
 * pure geometric presence check on all four axes -- no text length, vowel
 * ratio, or word count is evaluated anywhere here, so it cannot be gamed by
 * OCR noise shaped like real text, and a false "paragraph detected" only
 * ever makes the crop MORE conservative, never less. Strict `<`/`>`
 * comparisons (never `<=`/`>=`) mean a paragraph that merely TOUCHES a
 * zone's edge, with zero actual overlap, never triggers the cap. When
 * `paragraphs` is empty (no text data at all) or a given gap is already
 * empty/nonexistent, the corresponding check is a complete no-op.
 *
 * LEFT is included even though no layout constraint ever narrows the LEFT
 * edge directly (LayoutConstraints has no `left` field): applyTargetAspectRatio's
 * own expandDimension splits width growth between the LEFT and RIGHT sides
 * of the SAME call, and when one side's share can't be absorbed without
 * crossing its hard limit, the unused portion shifts to the OTHER side
 * ("shift, not shrink" -- computeApplicantPhotoCropRegion.ts's own
 * expandDimension doc comment). Tightening hardRight alone would therefore
 * redirect MORE width growth toward the LEFT edge, which, with no LEFT
 * check of its own, could still run all the way out to a loose hardLeft --
 * potentially crossing into real text on the LEFT side this fix would
 * otherwise never have considered. The LEFT occupancy check closes this
 * regardless of why growth is approaching hardLeft (its own share or
 * redirected share from RIGHT). The same reasoning applies symmetrically to
 * TOP/BOTTOM (one shared height-axis expandDimension call).
 *
 * TWO LIMITS OF THIS CHECK, both load-bearing for callers to understand:
 * 1. Face containment is NOT established here -- it depends entirely on
 *    `region` (the input) already fully containing the detected face
 *    BEFORE this function runs, which is the caller's own responsibility
 *    (computeApplicantPhotoCropRegion's margin expansion, plus
 *    clampRegionToBoundary's explicit face-containment guard, both upstream
 *    of this function). This function and applyTargetAspectRatio only ever
 *    cap or redirect GROWTH beyond `region`; they never shrink `region`
 *    itself, so a face already cut before this point stays cut.
 * 2. A paragraph that falls INSIDE `baseRegion`'s own footprint (not in the
 *    gap beyond it) is never inspected by any of the four checks below --
 *    that is a different problem (the face-only margin heuristic in
 *    computeApplicantPhotoCropRegion.ts already including unwanted text in
 *    its minimum output), out of scope for this purely growth-limiting
 *    check, and not something it is safe to "fix" here by shrinking below
 *    baseRegion (doing so would risk cutting the face that baseRegion's own
 *    margins were sized to protect).
 */
export function computeHardBounds(
  region: PixelCropRegion,
  baseRegion: BaseRegionEdges,
  imageWidth: number,
  imageHeight: number,
  documentBoundary: DocumentBoundaryResult | null,
  paragraphs: readonly NormalizedParagraph[],
): { hardLeft: number; hardTop: number; hardRight: number; hardBottom: number } {
  let hardLeft = 0;
  let hardTop = 0;
  let hardRight = imageWidth;
  let hardBottom = imageHeight;

  if (documentBoundary) {
    if (region.left >= documentBoundary.x0) hardLeft = Math.max(hardLeft, documentBoundary.x0);
    if (region.top >= documentBoundary.y0) hardTop = Math.max(hardTop, documentBoundary.y0);
    if (region.left + region.width <= documentBoundary.x1) hardRight = Math.min(hardRight, documentBoundary.x1);
    if (region.top + region.height <= documentBoundary.y1) hardBottom = Math.min(hardBottom, documentBoundary.y1);
  }

  // ROUNDING_EPSILON_PIXELS accounts for a real rounding mismatch found on
  // production passports 408 and 410 (see tests/visa.extractApplicantPhotoCrop.test.ts's
  // "REAL PASSPORT 408"/"410" tests): computeApplicantPhotoCropRegion.ts's own
  // narrowing "attempts" loop rounds `left` and `width` (or `top`/`height`)
  // INDEPENDENTLY via two separate Math.round() calls, each individually
  // bounded by that module's own documented 0.5px rounding tolerance --
  // when both round in the same direction, the compound drift on
  // region.left+region.width (or region.top+region.height) relative to the
  // true, pre-rounding appliedRightConstraint/appliedBottomConstraint value
  // can approach, but never reach, the sum of those two 0.5px tolerances
  // (1px). Without this tolerance, a ~0.52px compound drift silently
  // disqualified an already-accepted, already-safe narrowing constraint
  // here, letting applyTargetAspectRatio's growth step re-admit real
  // personal-data text that narrowing had successfully excluded moments
  // earlier. This tolerance only ever makes an ALREADY-accepted constraint
  // (computeApplicantPhotoCropRegion's own independent acceptance check
  // already vetted it as face-safe) more likely to be honored here -- it
  // never relaxes that acceptance check itself, so it carries no risk of
  // treating a constraint as safe that was not already judged so.
  const ROUNDING_EPSILON_PIXELS = 1;
  if (
    region.appliedRightConstraint !== undefined &&
    region.left + region.width <= region.appliedRightConstraint + ROUNDING_EPSILON_PIXELS
  ) {
    hardRight = Math.min(hardRight, region.appliedRightConstraint);
  }
  if (
    region.appliedBottomConstraint !== undefined &&
    region.top + region.height <= region.appliedBottomConstraint + ROUNDING_EPSILON_PIXELS
  ) {
    hardBottom = Math.min(hardBottom, region.appliedBottomConstraint);
  }

  const baseRegionLeft = baseRegion.left;
  const baseRegionTop = baseRegion.top;
  const baseRegionRight = baseRegion.left + baseRegion.width;
  const baseRegionBottom = baseRegion.top + baseRegion.height;

  // region's own current span on each perpendicular axis -- same
  // "effectively baseRegion's own span" reasoning explained above.
  const regionXStart = region.left;
  const regionXEnd = region.left + region.width;
  const regionYStart = region.top;
  const regionYEnd = region.top + region.height;

  if (hardTop < baseRegionTop) {
    const zoneHasParagraph = paragraphs.some(
      (p) => p.y1 > hardTop && p.y0 < baseRegionTop && p.x1 > regionXStart && p.x0 < regionXEnd,
    );
    if (zoneHasParagraph) hardTop = baseRegionTop;
  }

  if (hardBottom > baseRegionBottom) {
    const zoneHasParagraph = paragraphs.some(
      (p) => p.y0 < hardBottom && p.y1 > baseRegionBottom && p.x1 > regionXStart && p.x0 < regionXEnd,
    );
    if (zoneHasParagraph) hardBottom = baseRegionBottom;
  }

  if (hardRight > baseRegionRight) {
    const zoneHasParagraph = paragraphs.some(
      (p) => p.x0 < hardRight && p.x1 > baseRegionRight && p.y1 > regionYStart && p.y0 < regionYEnd,
    );
    if (zoneHasParagraph) hardRight = baseRegionRight;
  }

  if (hardLeft < baseRegionLeft) {
    const zoneHasParagraph = paragraphs.some(
      (p) => p.x1 > hardLeft && p.x0 < baseRegionLeft && p.y1 > regionYStart && p.y0 < regionYEnd,
    );
    if (zoneHasParagraph) hardLeft = baseRegionLeft;
  }

  return { hardLeft, hardTop, hardRight, hardBottom };
}
