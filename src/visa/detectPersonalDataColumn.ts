/**
 * Loose geometry shape shared with locateMrzParagraphGeometry.ts and
 * transformVisionCoordinates.ts's NormalizedParagraph — deliberately
 * duplicated rather than imported, matching this codebase's existing
 * "loose/local shape" convention (see VisionFaceAnnotation in
 * computeApplicantPhotoCropRegion.ts), so this module stays trivially
 * unit-testable with plain object fixtures.
 */
export interface LayoutParagraph {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface FaceBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export type PersonalDataColumnConfidence = 'HIGH' | 'MEDIUM' | 'LOW';

export interface PersonalDataColumnResult {
  /** Leftmost x0 among the winning cluster's members — the boundary closest to the face/photo side of the page. */
  columnX0: number;
  confidence: PersonalDataColumnConfidence;
  memberCount: number;
}

// Real-passport-calibrated constants (406/381/382/380 — see the engagement's
// own read-only geometry diagnostics). First-pass heuristic values, not a
// measured standard; retune against more real samples if a shadow-mode
// rollout surfaces systematic misses.
const MIN_TEXT_LENGTH = 2;
const HEADER_BAND_FRACTION = 0.06;
const MAX_PARAGRAPH_WIDTH_FRACTION = 0.4;
const CLUSTER_TOLERANCE_FRACTION = 0.03;
const MIN_FIELD_COUNT = 4;
const MIN_VERTICAL_SPAN_FRACTION = 0.2;
const DISPERSION_BAD_FRACTION = 0.05;
const GAP_MIN_FRACTION = 0.02;
const GAP_MAX_FRACTION = 0.08;
const HIGH_CONFIDENCE_THRESHOLD = 0.7;
const MEDIUM_CONFIDENCE_THRESHOLD = 0.4;

function overlapArea(a: FaceBox, b: FaceBox): number {
  const xOverlap = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
  const yOverlap = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  return xOverlap * yOverlap;
}

/**
 * Excludes a candidate paragraph only when the MAJORITY of its own area
 * sits inside the expanded face region — not on any overlap at all. The
 * expanded face region passed in by the caller is the CURRENT (pre-fix)
 * over-extended face-only crop candidate, which is exactly wide enough to
 * already reach into the real personal-data column on real passports (see
 * this engagement's own 381 diagnostic: the existing crop's right edge at
 * x=377 sits well past the column's own x0≈310). A naive "any overlap"
 * rule would therefore wrongly exclude the very column paragraphs this
 * function exists to find, since they legitimately START inside that
 * over-extended boundary but extend mostly beyond it. Genuine OCR noise
 * arising from the printed photo's own texture (hologram/security
 * pattern), by contrast, sits almost entirely inside the face region —
 * reliably far above this 50% threshold.
 */
function mostlyInsideRegion(paragraph: LayoutParagraph, region: FaceBox): boolean {
  const area = Math.max(0, paragraph.x1 - paragraph.x0) * Math.max(0, paragraph.y1 - paragraph.y0);
  if (area <= 0) return false;
  return overlapArea(paragraph, region) / area > 0.5;
}

/**
 * Finds the passport's printed personal-data field column (FAMILIYASI /
 * IBRAGIMOVA / ISMI / MARYAM / ... — see this engagement's own real-passport
 * diagnostics for 406/381/382/380, all independently confirmed) from Vision
 * DOCUMENT_TEXT_DETECTION paragraph geometry, so the applicant portrait crop
 * can stop short of it instead of cropping straight through it.
 *
 * Returns null — never a guessed boundary — whenever no cluster of at
 * least MIN_FIELD_COUNT independent paragraphs, spanning at least
 * MIN_VERTICAL_SPAN_FRACTION of the page height, forms to the right of the
 * face. A non-null result still carries its own confidence; callers
 * (extractApplicantPhotoCrop.ts) apply the resulting boundary only when
 * confidence is 'HIGH'.
 */
export function detectPersonalDataColumn(
  paragraphs: readonly LayoutParagraph[],
  faceBox: FaceBox,
  expandedFaceRegion: FaceBox,
  pageWidth: number,
  pageHeight: number,
  mrzParagraphs: readonly LayoutParagraph[] = [],
): PersonalDataColumnResult | null {
  if (pageWidth <= 0 || pageHeight <= 0) return null;

  const isMrzParagraph = (p: LayoutParagraph): boolean =>
    mrzParagraphs.some((m) => m.x0 === p.x0 && m.y0 === p.y0 && m.x1 === p.x1 && m.y1 === p.y1);

  const candidates = paragraphs.filter((p) => {
    if (p.x0 <= faceBox.x1) return false;
    if (p.text.trim().length < MIN_TEXT_LENGTH) return false;
    if (p.y0 <= HEADER_BAND_FRACTION * pageHeight) return false;
    if (p.x1 - p.x0 >= MAX_PARAGRAPH_WIDTH_FRACTION * pageWidth) return false;
    if (mostlyInsideRegion(p, expandedFaceRegion)) return false;
    if (isMrzParagraph(p)) return false;
    return true;
  });

  if (candidates.length === 0) return null;

  const tolerance = CLUSTER_TOLERANCE_FRACTION * pageWidth;
  const sorted = [...candidates].sort((a, b) => a.x0 - b.x0);

  const clusters: LayoutParagraph[][] = [];
  let current: LayoutParagraph[] = [sorted[0]!];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const curr = sorted[i]!;
    if (curr.x0 - prev.x0 <= tolerance) {
      current.push(curr);
    } else {
      clusters.push(current);
      current = [curr];
    }
  }
  clusters.push(current);

  const rangeOf = (members: LayoutParagraph[]): number =>
    Math.max(...members.map((m) => m.x0)) - Math.min(...members.map((m) => m.x0));

  const winningCluster = clusters.reduce<LayoutParagraph[] | null>((best, c) => {
    if (!best) return c;
    if (c.length > best.length) return c;
    if (c.length === best.length && rangeOf(c) < rangeOf(best)) return c;
    return best;
  }, null);

  if (!winningCluster || winningCluster.length < MIN_FIELD_COUNT) return null;

  const memberX0s = winningCluster.map((m) => m.x0);
  const columnX0 = Math.min(...memberX0s);
  const x0Range = Math.max(...memberX0s) - columnX0;

  const memberYs = winningCluster.flatMap((m) => [m.y0, m.y1]);
  const verticalSpan = Math.max(...memberYs) - Math.min(...memberYs);
  if (verticalSpan < MIN_VERTICAL_SPAN_FRACTION * pageHeight) return null;

  const gap = columnX0 - faceBox.x1;

  const fieldCountScore = Math.min(1, winningCluster.length / 8);
  const dispersionScore = Math.max(0, 1 - x0Range / (DISPERSION_BAD_FRACTION * pageWidth));
  const faceGapScore = gap >= GAP_MIN_FRACTION * pageWidth && gap <= GAP_MAX_FRACTION * pageWidth ? 1 : 0.3;

  const confidenceScore = Math.min(fieldCountScore, dispersionScore, faceGapScore);
  const confidence: PersonalDataColumnConfidence =
    confidenceScore >= HIGH_CONFIDENCE_THRESHOLD
      ? 'HIGH'
      : confidenceScore >= MEDIUM_CONFIDENCE_THRESHOLD
        ? 'MEDIUM'
        : 'LOW';

  return { columnX0, confidence, memberCount: winningCluster.length };
}
