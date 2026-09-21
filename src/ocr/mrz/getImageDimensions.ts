import sharp from 'sharp';

export interface ImageDimensions {
  width: number;
  height: number;
}

export async function getImageDimensions(imageBuffer: Buffer): Promise<ImageDimensions> {
  const metadata = await sharp(imageBuffer).metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error('Could not read image dimensions');
  }
  return { width: metadata.width, height: metadata.height };
}
