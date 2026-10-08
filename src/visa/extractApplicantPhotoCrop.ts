import sharp from 'sharp';
import { getImageDimensions } from '../ocr/mrz/getImageDimensions.js';
import { locateMrzParagraphGeometry } from '../ocr/mrz/locateMrzParagraphGeometry.js';
import type { VisionPage } from '../ocr/visual/extractIssueDateFromVisionStructure.js';
import {
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

/**
 * Builds the optional layout-aware crop constraints (personal-data column
 * -> right boundary, MRZ -> bottom boundary) from already-flattened,
 * EXIF-normalized paragraph geometry (see flattenParagraphsToNormalizedSpace
 * / detectDocumentBoundary.ts's own optional pre-filtering of that same
 * list) -- no Vision API call of its own, pure and synchronous. Returns
 * undefined when neither signal reaches HIGH confidence, which is exactly
 * "fall back to the pure face-only crop", never a guess.
 */
function buildLayoutConstraintsFromParagraphs(
  paragraphs: readonly NormalizedParagraph[],
  faceBox: PixelBox,
  baseRegion: PixelCropRegion,
  normalizedWidth: number,
  normalizedHeight: number,
): LayoutConstraints | undefined {
  if (paragraphs.length === 0) return undefined;

  const expandedFaceRegion = {
    x0: baseRegion.left,
    y0: baseRegion.top,
    x1: baseRegion.left + baseRegion.width,
    y1: baseRegion.top + baseRegion.height,
  };

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
  if (columnResult && columnResult.confidence === 'HIGH') {
    const margin = Math.max(MIN_MARGIN_PIXELS, RIGHT_MARGIN_FRACTION * normalizedWidth);
    constraints.right = columnResult.columnX0 - margin;
  }
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
        const layoutConstraints = buildLayoutConstraintsFromParagraphs(
          paragraphsForLayout,
          faceBox,
          baseRegion,
          width,
          height,
        );
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
        region = clampRegionToBoundary(region, documentBoundary, faceBox);
      }
    } catch (error) {
      console.log(
        `[applicant-photo-crop] document boundary clamp failed, using unclamped region: ${sanitizeErrorReason(error)}`,
      );
    }
  }

  return encodeCrop(normalizedBuffer, region, mimeType);
}
