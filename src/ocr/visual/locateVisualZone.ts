import { cropRegion } from '../mrz/cropRegion.js';
import { getImageDimensions } from '../mrz/getImageDimensions.js';
import { FALLBACK_CROP_BOTTOM_FRACTION } from '../mrz/locateMrzRegion.js';

/**
 * Crops the region above the MRZ band — where a passport's visual
 * (printed, non-MRZ) data fields live, such as the issue date. Reuses the
 * same top boundary the MRZ crop starts from (FALLBACK_CROP_BOTTOM_FRACTION)
 * so the two regions never overlap.
 */
export async function locateVisualZone(imageBuffer: Buffer): Promise<Buffer> {
  const { width, height } = await getImageDimensions(imageBuffer);
  const cropHeight = Math.round(height * FALLBACK_CROP_BOTTOM_FRACTION);

  // Diagnostic only: pure geometry (pixel dimensions), never image content.
  console.log(`[visual-crop] original=${width}x${height} cropHeight=${cropHeight}`);

  return cropRegion(imageBuffer, 0, cropHeight);
}
