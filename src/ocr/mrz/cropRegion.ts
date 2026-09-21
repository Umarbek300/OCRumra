import sharp from 'sharp';

export interface CropRegionOptions {
  /**
   * Hard binarization (threshold) on top of the usual contrast
   * normalization — helps on photos with uneven lighting (shadows,
   * glare) that plain contrast-stretching doesn't fully correct.
   */
  binarize?: boolean;
  /**
   * Upscale factor applied via lanczos3 resize. Defaults to 2 — the
   * original, unchanged production behavior for every caller that doesn't
   * specify this. Higher values (3, 4) are used by the MRZ pipeline's
   * enhanced-preprocessing fallback attempts (see enhancedFallbackAttempts.ts)
   * for images where 2x isn't giving Tesseract enough resolution.
   */
  scale?: number;
  /**
   * Binarization threshold (0-255), only used when binarize is true.
   * Defaults to 150 — the original, unchanged production value.
   */
  threshold?: number;
  /**
   * Tightens the crop to the actual ink/content bounding box (via sharp's
   * trim()), removing blank margin the original top/height crop may have
   * included. Off by default — the original, unchanged production
   * behavior. Used by the MRZ pipeline's "localized" fallback attempts
   * (see geometryFallbackAttempts.ts) to test whether extra margin around
   * the MRZ band was confusing Tesseract's line segmentation.
   */
  trim?: boolean;
  /**
   * Rotates the crop by this many degrees (positive = clockwise) before
   * upscaling, expanding the canvas as needed with a white background to
   * fit the tilted rectangle. Unset by default — the original, unchanged
   * production behavior. Used by the MRZ pipeline's "deskew" fallback
   * attempts (see geometryFallbackAttempts.ts) to test whether a slight
   * camera tilt was breaking line recognition.
   */
  rotateDegrees?: number;
}

const DEFAULT_SCALE = 2;
const DEFAULT_THRESHOLD_VALUE = 150;

/**
 * Crops an explicit pixel region and applies the same enhancement as the
 * original fixed-crop pipeline (grayscale, contrast-normalize, upscale,
 * sharpen), with an optional binarization pass. Purely local image
 * processing — nothing leaves the process, no temp file.
 */
export async function cropRegion(imageBuffer: Buffer, top: number, height: number, options: CropRegionOptions = {}): Promise<Buffer> {
  const metadata = await sharp(imageBuffer).metadata();
  const width = metadata.width;
  if (!width) {
    throw new Error('Could not read image width for MRZ region crop');
  }

  const scale = options.scale ?? DEFAULT_SCALE;
  const threshold = options.threshold ?? DEFAULT_THRESHOLD_VALUE;

  // extract() is materialized into its own buffer before trim() runs —
  // chaining .extract().trim() directly in one sharp pipeline triggers a
  // libvips "bad extract area" error (trim's internal region calculation
  // doesn't account for the preceding crop correctly). Starting a fresh
  // pipeline from the already-cropped buffer avoids that entirely.
  const extractedBuffer = await sharp(imageBuffer).extract({ left: 0, top, width, height }).png().toBuffer();

  let preprocessed = sharp(extractedBuffer).grayscale().normalize();

  if (options.rotateDegrees !== undefined) {
    preprocessed = preprocessed.rotate(options.rotateDegrees, { background: '#ffffff' });
  }
  if (options.trim) {
    preprocessed = preprocessed.trim();
  }

  // trim/rotate can change the crop's dimensions, so the upscale factor
  // must be resolved against the *current* (post-trim/rotate) width, not
  // the original pre-extract width — otherwise scale would stretch a
  // trimmed/rotated image back out to the original size and distort it.
  // When neither option is used, this is exactly `width` (extract never
  // crops horizontally), so default behavior is unchanged.
  const preprocessedBuffer = await preprocessed.png().toBuffer();
  const currentWidth = (await sharp(preprocessedBuffer).metadata()).width ?? width;

  let pipeline = sharp(preprocessedBuffer).resize({ width: currentWidth * scale, kernel: 'lanczos3' }).sharpen();

  if (options.binarize) {
    pipeline = pipeline.threshold(threshold);
  }

  return pipeline.png().toBuffer();
}
