import { ImageAnnotatorClient, protos } from '@google-cloud/vision';
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
import { detectPersonalDataColumn } from './detectPersonalDataColumn.js';
import { flattenParagraphsToNormalizedSpace, type RawImageGeometry } from './transformVisionCoordinates.js';

const MAX_ERROR_MESSAGE_LENGTH = 300;

export interface DetectFacesResult {
  faces: VisionFaceAnnotation[];
}

export type DetectFacesFn = (imageBuffer: Buffer) => Promise<DetectFacesResult>;

export interface ExtractApplicantPhotoCropDependencies {
  detectFaces: DetectFacesFn;
}

/** Bounded the same way googleVisionProvider.ts bounds its own Vision error messages -- defense in depth. */
function sanitizeErrorReason(error: unknown): string {
  const message = error instanceof Error ? error.message : 'unknown error';
  return message.slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

let realVisionClient: ImageAnnotatorClient | null = null;
function getRealVisionClient(): ImageAnnotatorClient {
  if (!realVisionClient) {
    realVisionClient = new ImageAnnotatorClient();
  }
  return realVisionClient;
}

/**
 * Dedicated FACE_DETECTION-only Vision call, deliberately independent of
 * whichever text-extraction OCR_PROVIDER is configured (google-vision/
 * anthropic/local/compare) -- the applicant-photo crop must work the same
 * way regardless of that setting, since it answers a different question
 * ("where is the face in this image") than any text-extraction provider
 * does, and performPassportOcr.ts already calls uploadApplicantPhoto
 * unconditionally today, independent of OCR_PROVIDER.
 *
 * This IS a second Vision API call on top of googleVisionProvider.ts's own
 * DOCUMENT_TEXT_DETECTION call when OCR_PROVIDER=google-vision (Vision's
 * client does support combining multiple feature types into one
 * annotateImage()/batchAnnotateImages() request, which would avoid that --
 * but doing so here would mean threading Vision-specific face geometry back
 * out through the provider-agnostic OcrProvider interface, which every
 * other provider (anthropic/local) has no equivalent for, or wiring this
 * module's internals into googleVisionProvider.ts specifically and breaking
 * its independence from the configured provider. A second, cheap,
 * FACE_DETECTION-only call -- isolated so a failure here can never fail the
 * OCR job itself (see performPassportOcr.ts's own try/catch around this) --
 * is the smaller, safer change for the bounded message volumes this system
 * handles.
 */
async function detectFacesReal(imageBuffer: Buffer): Promise<DetectFacesResult> {
  const client = getRealVisionClient();
  const [response]: [protos.google.cloud.vision.v1.IAnnotateImageResponse] = await client.faceDetection(imageBuffer);
  if (response.error?.message) {
    throw new Error(response.error.message);
  }
  return { faces: (response.faceAnnotations ?? []) as VisionFaceAnnotation[] };
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
 * -> right boundary, MRZ -> bottom boundary) from the SAME
 * DOCUMENT_TEXT_DETECTION `pages` googleVisionProvider.ts already computed
 * during OCR text extraction -- no second Vision API call. Returns
 * undefined (never throws past this point for a detection miss -- only a
 * genuine, unexpected error propagates to the caller's own try/catch) when
 * neither signal reaches HIGH confidence, which is exactly "fall back to
 * the pure face-only crop", never a guess.
 *
 * `rawImageBuffer` here is the ORIGINAL, pre-rotation buffer (the one
 * DOCUMENT_TEXT_DETECTION itself was called on in googleVisionProvider.ts)
 * -- its EXIF orientation tag is read via sharp's metadata() (cheap, no
 * full pixel decode) and used to transform Vision's raw-buffer paragraph
 * coordinates into the SAME EXIF-normalized space `faceBox`/`baseRegion`
 * already live in (see transformVisionCoordinates.ts's own doc comment for
 * why this transform is necessary at all).
 */
async function buildLayoutConstraints(
  rawImageBuffer: Buffer,
  pages: readonly VisionPage[],
  faceBox: PixelBox,
  baseRegion: PixelCropRegion,
  normalizedWidth: number,
  normalizedHeight: number,
): Promise<LayoutConstraints | undefined> {
  const rawMeta = await sharp(rawImageBuffer).metadata();
  const rawWidth = rawMeta.width ?? 0;
  const rawHeight = rawMeta.height ?? 0;
  if (rawWidth <= 0 || rawHeight <= 0) return undefined;

  const geometry: RawImageGeometry = { rawWidth, rawHeight, orientation: rawMeta.orientation };
  const paragraphs = flattenParagraphsToNormalizedSpace(pages, geometry);
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
 * band (see buildLayoutConstraints above) -- but ONLY when that detection
 * independently reaches HIGH confidence AND keeps the detected face safely
 * contained; otherwise, or when this parameter is omitted entirely (every
 * other OCR provider, and every existing caller/test), this function's
 * behavior is exactly the original pure face-only crop.
 */
export async function extractApplicantPhotoCrop(
  imageBuffer: Buffer,
  mimeType: string,
  deps: ExtractApplicantPhotoCropDependencies = defaultDependencies,
  textDetectionPages?: readonly VisionPage[],
): Promise<Buffer | null> {
  const normalizedBuffer = await sharp(imageBuffer).rotate().toBuffer();

  let faces: VisionFaceAnnotation[];
  try {
    ({ faces } = await deps.detectFaces(normalizedBuffer));
  } catch (error) {
    const reason = sanitizeErrorReason(error);
    console.log(`[applicant-photo-crop] Vision face detection call failed: ${reason}`);
    throw new Error(`Google Vision face detection call failed: ${reason}`);
  }

  const { width, height } = await getImageDimensions(normalizedBuffer);
  const baseRegion = computeApplicantPhotoCropRegion(faces, width, height);
  if (!baseRegion) {
    console.log('[applicant-photo-crop] no reliable photo region found; skipping photo for this message');
    return null;
  }

  let region = baseRegion;
  if (textDetectionPages && textDetectionPages.length > 0) {
    const faceBox = selectBestFaceBox(faces);
    if (faceBox) {
      try {
        const layoutConstraints = await buildLayoutConstraints(
          imageBuffer,
          textDetectionPages,
          faceBox,
          baseRegion,
          width,
          height,
        );
        if (layoutConstraints) {
          const constrainedRegion = computeApplicantPhotoCropRegion(faces, width, height, layoutConstraints);
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

  return encodeCrop(normalizedBuffer, region, mimeType);
}
