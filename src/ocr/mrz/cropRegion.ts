import sharp from 'sharp';

export interface CropRegionOptions {
  /**
   * Hard binarization (threshold) on top of the usual contrast
   * normalization — helps on photos with uneven lighting (shadows,
   * glare) that plain contrast-stretching doesn't fully correct.
   */
  binarize?: boolean;
}

const THRESHOLD_VALUE = 150;

/**
 * Crops an explicit pixel region and applies the same enhancement as the
 * original fixed-crop pipeline (grayscale, contrast-normalize, 2x
 * upscale, sharpen), with an optional binarization pass. Purely local
 * image processing — nothing leaves the process, no temp file.
 */
export async function cropRegion(imageBuffer: Buffer, top: number, height: number, options: CropRegionOptions = {}): Promise<Buffer> {
  const metadata = await sharp(imageBuffer).metadata();
  const width = metadata.width;
  if (!width) {
    throw new Error('Could not read image width for MRZ region crop');
  }

  let pipeline = sharp(imageBuffer)
    .extract({ left: 0, top, width, height })
    .grayscale()
    .normalize()
    .resize({ width: width * 2, kernel: 'lanczos3' })
    .sharpen();

  if (options.binarize) {
    pipeline = pipeline.threshold(THRESHOLD_VALUE);
  }

  return pipeline.png().toBuffer();
}
