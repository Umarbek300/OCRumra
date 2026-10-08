import sharp from 'sharp';
import { getImageDimensions } from '../ocr/mrz/getImageDimensions.js';
import type { VisionPage } from '../ocr/visual/extractIssueDateFromVisionStructure.js';
import type { VisionFaceAnnotation } from './computeApplicantPhotoCropRegion.js';
import { detectDocumentBoundary, type DocumentBoundaryResult } from './detectDocumentBoundary.js';
import { flattenParagraphsToNormalizedSpace, type RawImageGeometry } from './transformVisionCoordinates.js';

const MAX_ERROR_MESSAGE_LENGTH = 300;
/** Same floor detectDocumentBoundary.ts's own clampRegionToBoundary uses — deliberately duplicated, not imported, matching this engagement's established "loose/local shape, no cross-module coupling" convention for these visa/ modules. */
const MIN_CANONICAL_DIMENSION_PIXELS = 80;

function sanitizeErrorReason(error: unknown): string {
  const message = error instanceof Error ? error.message : 'unknown error';
  return message.slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

export interface CanonicalPassportImageResult {
  /** The canonical passport-only (or, when no reliable boundary exists, the full EXIF-normalized) image bytes. */
  buffer: Buffer;
  /** Best-effort dimensions of `buffer`. 0 only in the rare total-failure fallback below, where `buffer` is the untouched original and its real dimensions were never read — never used for anything beyond diagnostics by any caller. */
  width: number;
  height: number;
  /** The detected boundary this crop was built from, or null when no crop was applied (safe fallback). Diagnostic only. */
  boundary: DocumentBoundaryResult | null;
}

/**
 * Builds the SINGLE canonical passport-only image that is now shared by
 * both stored artifacts this engagement maintains for a passport message:
 * the T-column (personalPhotoObjectPath) upload AND the input the V-column
 * portrait-crop step starts from conceptually represents "the passport,
 * isolated from whatever background or hand was visible in the original
 * Telegram photo" — see this feature's own design notes for why the actual
 * V-column mechanism (extractApplicantPhotoCrop.ts) achieves that same
 * outcome via its own already-tested internal boundary clamp rather than by
 * literally being re-pointed at this function's output (re-running Vision
 * OCR on an image whose own crop boundary is DERIVED from that OCR's output
 * is circular; doing so would also either double this system's Vision cost
 * or require shifting Vision's raw nested proto structures, which is fragile
 * and was rejected for this pass).
 *
 * Uses the SAME document-boundary approximation as detectDocumentBoundary.ts
 * (bounding-box isolation of real text + nearby faces, NOT true document-
 * edge detection or perspective/homography rectification — see that
 * module's own doc comment for why). `faces` is expected to be the result of
 * a Vision FACE_DETECTION call the caller already made (performPassportOcr.ts
 * shares ONE such call between this function and the portrait-crop step) —
 * this function makes NO Vision API call of its own.
 *
 * NEVER throws. Falls back to the full EXIF-normalized original image
 * (never a guessed or corrupted crop) whenever: no text pages are available,
 * the boundary can't be confidently detected, the resulting crop would be
 * smaller than a sane minimum, or anything unexpected goes wrong while
 * computing any of the above. In the (extremely unlikely) case that even
 * reading/normalizing the input buffer itself fails, falls back to the
 * completely untouched original buffer — passport processing (OCR, the
 * T-column upload, the V-column crop) must never fail because this
 * function could not produce an improved image.
 */
export async function buildCanonicalPassportImage(
  imageBuffer: Buffer,
  faces: readonly VisionFaceAnnotation[],
  textDetectionPages?: readonly VisionPage[],
): Promise<CanonicalPassportImageResult> {
  try {
    const normalizedBuffer = await sharp(imageBuffer).rotate().toBuffer();
    const { width, height } = await getImageDimensions(normalizedBuffer);

    if (!textDetectionPages || textDetectionPages.length === 0) {
      return { buffer: normalizedBuffer, width, height, boundary: null };
    }

    const rawMeta = await sharp(imageBuffer).metadata();
    const rawWidth = rawMeta.width ?? 0;
    const rawHeight = rawMeta.height ?? 0;
    if (rawWidth <= 0 || rawHeight <= 0) {
      return { buffer: normalizedBuffer, width, height, boundary: null };
    }

    const geometry: RawImageGeometry = { rawWidth, rawHeight, orientation: rawMeta.orientation };
    const paragraphs = flattenParagraphsToNormalizedSpace(textDetectionPages, geometry);
    const boundary = detectDocumentBoundary(paragraphs, faces, width, height);
    if (!boundary) {
      return { buffer: normalizedBuffer, width, height, boundary: null };
    }

    const left = Math.max(0, Math.floor(boundary.x0));
    const top = Math.max(0, Math.floor(boundary.y0));
    const right = Math.min(width, Math.ceil(boundary.x1));
    const bottom = Math.min(height, Math.ceil(boundary.y1));
    const cropWidth = right - left;
    const cropHeight = bottom - top;
    if (cropWidth < MIN_CANONICAL_DIMENSION_PIXELS || cropHeight < MIN_CANONICAL_DIMENSION_PIXELS) {
      return { buffer: normalizedBuffer, width, height, boundary: null };
    }

    const canonicalBuffer = await sharp(normalizedBuffer)
      .extract({ left, top, width: cropWidth, height: cropHeight })
      .toBuffer();
    return { buffer: canonicalBuffer, width: cropWidth, height: cropHeight, boundary };
  } catch (error) {
    console.log(
      `[canonical-passport-image] failed to build the canonical image, falling back to the untouched original buffer: ${sanitizeErrorReason(error)}`,
    );
    return { buffer: imageBuffer, width: 0, height: 0, boundary: null };
  }
}
