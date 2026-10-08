import { ImageAnnotatorClient, protos } from '@google-cloud/vision';
import sharp from 'sharp';
import type { VisionFaceAnnotation } from './computeApplicantPhotoCropRegion.js';

export interface DetectFacesResult {
  faces: VisionFaceAnnotation[];
}

export type DetectFacesFn = (imageBuffer: Buffer) => Promise<DetectFacesResult>;

let realVisionClient: ImageAnnotatorClient | null = null;
function getRealVisionClient(): ImageAnnotatorClient {
  if (!realVisionClient) {
    realVisionClient = new ImageAnnotatorClient();
  }
  return realVisionClient;
}

/**
 * Dedicated FACE_DETECTION-only Vision call, deliberately independent of
 * whichever text-extraction OCR_PROVIDER is configured — see
 * extractApplicantPhotoCrop.ts's own (original) doc comment on this same
 * function for the full rationale. Extracted into its own module so
 * performPassportOcr.ts can make this ONE call and share its result with
 * BOTH extractApplicantPhotoCrop.ts (the V-column portrait crop) and
 * buildCanonicalPassportImage.ts (the T-column canonical image) — avoiding
 * a second, redundant Vision API call for the same image.
 *
 * EXIF-normalizes `imageBuffer` itself before calling Vision (sharp's
 * rotate() with no argument), so callers may pass either the raw downloaded
 * buffer or an already-normalized one — normalizing an already-normalized
 * buffer again is a harmless no-op (no EXIF tag left to apply), so this is
 * safe either way and keeps every caller's own coordinate space consistent
 * with whatever buffer IT normalizes for its own purposes.
 */
export async function detectFacesReal(imageBuffer: Buffer): Promise<DetectFacesResult> {
  const normalizedBuffer = await sharp(imageBuffer).rotate().toBuffer();
  const client = getRealVisionClient();
  const [response]: [protos.google.cloud.vision.v1.IAnnotateImageResponse] = await client.faceDetection(normalizedBuffer);
  if (response.error?.message) {
    throw new Error(response.error.message);
  }
  return { faces: (response.faceAnnotations ?? []) as VisionFaceAnnotation[] };
}
