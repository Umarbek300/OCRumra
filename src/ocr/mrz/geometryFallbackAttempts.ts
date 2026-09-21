export interface TrimFallbackAttempt {
  /** Whether to binarize after trimming. */
  binarize: boolean;
}

/**
 * Bounded, fixed set of "localized" attempts: tighten the existing
 * fallback crop region to its actual ink content (sharp's trim()) before
 * OCR, instead of trying more resolution/threshold on the untouched
 * region (already fully explored by ENHANCED_FALLBACK_ATTEMPTS with no
 * effect). Isolates a single hypothesis — extra blank margin/border
 * inside the crop confusing Tesseract's line segmentation — rather than
 * combining it with scale/threshold variants in this first pass.
 */
export const TRIM_FALLBACK_ATTEMPTS: readonly TrimFallbackAttempt[] = [{ binarize: false }, { binarize: true }];

export interface DeskewFallbackAttempt {
  /** Rotation angle in degrees (positive = clockwise). */
  rotateDegrees: number;
}

/**
 * Bounded, fixed set of "deskew" attempts: a few small rotation angles to
 * test whether a slight camera tilt is breaking Tesseract's line
 * recognition. 0 degrees is intentionally excluded — that's identical to
 * the already-tried stage 2/3 attempts. Always paired with binarization
 * (see enhancedFallbackAttempts.ts — plain vs. binarized already showed
 * no effect independent of preprocessing, so this isolates rotation
 * alone rather than re-testing that dimension).
 */
export const DESKEW_FALLBACK_ATTEMPTS: readonly DeskewFallbackAttempt[] = [
  { rotateDegrees: -4 },
  { rotateDegrees: -2 },
  { rotateDegrees: 2 },
  { rotateDegrees: 4 },
];
