import sharp from 'sharp';

/**
 * The original fixed-fraction crop. Kept as the final fallback (see
 * localProvider.ts) after the candidate-search strategy in
 * searchMrzLines.ts, which production evidence showed is needed since a
 * single fixed fraction isn't reliable across photos framed differently.
 */
export const FALLBACK_CROP_BOTTOM_FRACTION = 0.6;

/**
 * Crops the bottom band of a passport photo where TD3 MRZ always sits, and
 * lightly enhances it for OCR (grayscale, normalized contrast, upscaled —
 * Tesseract does much better on larger, high-contrast monospace text).
 * Purely local image processing (sharp, native binding) — nothing leaves
 * the process, no network call, no temp file.
 */
export async function locateMrzRegion(imageBuffer: Buffer): Promise<Buffer> {
  const image = sharp(imageBuffer);
  const metadata = await image.metadata();
  const width = metadata.width;
  const height = metadata.height;

  if (!width || !height) {
    throw new Error('Could not read image dimensions for MRZ region crop');
  }

  // TD3 MRZ (2 lines) sits in roughly the bottom 15-18% of a standard
  // passport photo page crop. A real production photo (537x420, far
  // smaller than typical) showed bottom-24% only fully captured one of
  // the two lines — at low resolution there's less margin for imprecise
  // framing, so bottom 40% gives real headroom for both lines to land
  // fully inside the crop, still well short of pulling in the visual
  // page above the MRZ block.
  const cropTop = Math.round(height * FALLBACK_CROP_BOTTOM_FRACTION);
  const cropHeight = height - cropTop;

  // Diagnostic only: pure geometry (pixel dimensions), never image content.
  console.log(
    `[mrz-crop] original=${width}x${height} cropTop=${cropTop} cropHeight=${cropHeight} cropRegion=${width}x${cropHeight}`,
  );

  return sharp(imageBuffer)
    .extract({ left: 0, top: cropTop, width, height: cropHeight })
    .grayscale()
    .normalize()
    .resize({ width: width * 2, kernel: 'lanczos3' })
    .sharpen()
    .png()
    .toBuffer();
}
