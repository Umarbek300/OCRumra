import sharp from 'sharp';

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
  // passport photo page crop; 24% gives headroom for imprecise framing
  // without pulling in enough of the photo/visual page to confuse OCR.
  const cropTop = Math.round(height * 0.76);
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
