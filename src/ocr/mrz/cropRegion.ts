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

  let pipeline = sharp(imageBuffer)
    .extract({ left: 0, top, width, height })
    .grayscale()
    .normalize()
    .resize({ width: width * scale, kernel: 'lanczos3' })
    .sharpen();

  if (options.binarize) {
    pipeline = pipeline.threshold(threshold);
  }

  return pipeline.png().toBuffer();
}
