import { cropRegion } from './cropRegion.js';
import { normalizeMrzLineLength } from './normalizeMrzLine.js';
import { runTesseractOcr } from './runTesseractOcr.js';

export interface SplitLineOcrDependencies {
  cropRegion: typeof cropRegion;
  runTesseractOcr: typeof runTesseractOcr;
}

const defaultDependencies: SplitLineOcrDependencies = { cropRegion, runTesseractOcr };

function cleanSingleLine(rawOcrText: string): string {
  return rawOcrText.replace(/\s+/g, '').toUpperCase();
}

/**
 * OCRs the top and bottom halves of a region *separately*, single-line
 * PSM (7) each, instead of as one combined multi-line block — often more
 * accurate, since it avoids Tesseract's own line-segmentation heuristics
 * misjudging where one line ends and the next begins. Used as a later
 * fallback stage, after the primary candidate search and the plain/
 * binarized combined-block fallback attempts have all failed. Never logs
 * OCR'd text.
 */
export async function splitLineOcr(
  imageBuffer: Buffer,
  top: number,
  height: number,
  deps: SplitLineOcrDependencies = defaultDependencies,
): Promise<string[]> {
  const halfHeight = Math.max(1, Math.round(height / 2));

  const [topCrop, bottomCrop] = await Promise.all([
    deps.cropRegion(imageBuffer, top, halfHeight),
    deps.cropRegion(imageBuffer, top + halfHeight, height - halfHeight),
  ]);

  const [topText, bottomText] = await Promise.all([
    deps.runTesseractOcr(topCrop, { psm: 7 }),
    deps.runTesseractOcr(bottomCrop, { psm: 7 }),
  ]);

  return [normalizeMrzLineLength(cleanSingleLine(topText)), normalizeMrzLineLength(cleanSingleLine(bottomText))];
}
