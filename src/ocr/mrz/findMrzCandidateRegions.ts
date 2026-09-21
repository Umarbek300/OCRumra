export interface MrzCropCandidate {
  top: number;
  height: number;
}

// Ordered tightest-first: assumes the passport page fills most of the
// frame first (the common case), then progressively widens. Production
// evidence showed a single fixed fraction is not reliable across photos
// taken at different distances/framing — this is a small, bounded,
// deterministic geometric search (not real document-boundary detection,
// which would need a new dependency), not a guess about any one photo.
const CANDIDATE_BOTTOM_FRACTIONS = [0.75, 0.68, 0.6] as const;

/**
 * Returns an ordered list of candidate MRZ crop regions (pixel top/height)
 * to try in turn. Pure geometry — no image content, no I/O.
 */
export function findMrzCandidateRegions(width: number, height: number): MrzCropCandidate[] {
  return CANDIDATE_BOTTOM_FRACTIONS.map((fraction) => {
    const top = Math.round(height * fraction);
    return { top, height: height - top };
  });
}
