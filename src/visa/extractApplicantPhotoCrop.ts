import { ImageAnnotatorClient, protos } from '@google-cloud/vision';
import sharp from 'sharp';
import { getImageDimensions } from '../ocr/mrz/getImageDimensions.js';
import { computeApplicantPhotoCropRegion, type PixelCropRegion, type VisionFaceAnnotation } from './computeApplicantPhotoCropRegion.js';

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
 */
export async function extractApplicantPhotoCrop(
  imageBuffer: Buffer,
  mimeType: string,
  deps: ExtractApplicantPhotoCropDependencies = defaultDependencies,
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
  const region = computeApplicantPhotoCropRegion(faces, width, height);
  if (!region) {
    console.log('[applicant-photo-crop] no reliable photo region found; skipping photo for this message');
    return null;
  }

  return encodeCrop(normalizedBuffer, region, mimeType);
}
