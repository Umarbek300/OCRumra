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

  // Promise.allSettled (not Promise.all): the top/bottom OCR subprocesses
  // are still launched concurrently, but one half's Tesseract process
  // crashing (e.g. a SIGFPE seen in production on certain crops at --psm 7)
  // must never discard the other half's already-computed result, and must
  // never make this function reject. A crashed/failed half's text becomes
  // '' — identical in shape to Tesseract legitimately reading no
  // recognizable text, which parseAndValidateMrz already rejects without
  // any special-casing.
  const [topSettled, bottomSettled] = await Promise.allSettled([
    deps.runTesseractOcr(topCrop, { psm: 7, oem: 1 }),
    deps.runTesseractOcr(bottomCrop, { psm: 7, oem: 1 }),
  ]);

  const topText = topSettled.status === 'fulfilled' ? topSettled.value : '';
  const bottomText = bottomSettled.status === 'fulfilled' ? bottomSettled.value : '';

  return [normalizeMrzLineLength(cleanSingleLine(topText)), normalizeMrzLineLength(cleanSingleLine(bottomText))];
}
