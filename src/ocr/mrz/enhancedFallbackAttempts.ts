export interface EnhancedFallbackAttempt {
  /** Upscale factor (see CropRegionOptions.scale). */
  scale: number;
  /** Binarization threshold; omitted means a plain (non-binarized) attempt. */
  threshold?: number;
}

/**
 * A bounded, deliberately small set of stronger preprocessing variants,
 * tried only after every existing fallback stage (the original 2x/150
 * pipeline) has already failed. Production diagnostic logs showed some
 * passport photos never produce a 44-character MRZ line even after
 * OEM-1 — this is the next variable to test empirically: does more
 * resolution and/or a different binarization cutoff help Tesseract read
 * the same crop region.
 *
 * A fixed, enumerable list — not a dynamic cross-product with crop region,
 * PSM, or OEM — so this stays bounded regardless of how many scale/
 * threshold combinations get added later. Ordered smaller scale before
 * larger (a larger upscale costs more per Tesseract call, and log
 * evidence should decide whether it's worth it) and plain before
 * binarized at each scale.
 */
export const ENHANCED_FALLBACK_ATTEMPTS: readonly EnhancedFallbackAttempt[] = [
  { scale: 3 },
  { scale: 3, threshold: 120 },
  { scale: 3, threshold: 150 },
  { scale: 3, threshold: 180 },
  { scale: 4 },
  { scale: 4, threshold: 120 },
  { scale: 4, threshold: 150 },
  { scale: 4, threshold: 180 },
];
