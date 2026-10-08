/**
 * Loose geometry shape shared with detectPersonalDataColumn.ts and
 * transformVisionCoordinates.ts's NormalizedParagraph — deliberately
 * duplicated rather than imported, matching this codebase's existing
 * "loose/local shape" convention (see VisionFaceAnnotation in
 * computeApplicantPhotoCropRegion.ts), so this module stays trivially
 * unit-testable with plain object fixtures and has no dependency on src/visa/.
 */
export interface LayoutParagraph {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export type MrzGeometryConfidence = 'HIGH' | 'MEDIUM' | 'LOW';

export interface MrzGeometryResult {
  /** The MRZ paragraph's own top edge (y0) — the crop's bottom boundary is derived from this, not from this module. */
  top: number;
  confidence: MrzGeometryConfidence;
  paragraph: LayoutParagraph;
}

// Real-passport-calibrated constants (406/381/382/380). 381 is the proof
// case: its existing checksum-based findMrzCandidateWindows/
// selectMrzCandidateWinner returns firstStructuralMatch=null (the OCR'd
// line pair is 2 characters short of the canonical TD3 44, so the fixed-
// position parser never even structurally matches) — yet this module's
// geometry+identity signal alone reaches HIGH confidence for it, verified
// against the real Vision paragraph dump.
const MIN_TEXT_LENGTH = 20;
const MIN_WIDTH_FRACTION = 0.5;
const MIN_Y0_FRACTION_HARD = 0.5; // candidates above the page's bottom half are never MRZ
const MIN_Y0_FRACTION_STRONG = 0.75;
const MIN_WIDTH_FRACTION_STRONG = 0.75;
const LONG_ALPHABET_RUN_PATTERN = /[A-Z0-9<]{40,}/;
const PLAUSIBLE_LENGTH_MIN = 70;
const PLAUSIBLE_LENGTH_MAX = 100;
const MIN_IDENTITY_TOKEN_LENGTH = 5;
const MIN_IDENTITY_MATCHES = 2;

function normalizeForMatch(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9<]/g, '');
}

function normalizeLettersOnly(text: string): string {
  return text.toUpperCase().replace(/[^A-Z]/g, '');
}

/**
 * Independent, language-agnostic identity cross-check: counts how many
 * OTHER paragraphs on the same page (e.g. the personal-data column's own
 * FAMILIYASI/ISMI/OTASINING ISMI field VALUES — IBRAGIMOVA, MARYAM,
 * BOTIROVNA) appear, letters-only, as a substring inside the MRZ
 * candidate's own text. Deliberately does NOT depend on the structured
 * extraction result (extraction.surname/firstName/...), which is exactly
 * null in the 381 case this module exists to handle — it only ever needs
 * the SAME flattened paragraph list already computed for column detection.
 * Short tokens (country codes, bare digits) are excluded by
 * MIN_IDENTITY_TOKEN_LENGTH so they can never contribute a spurious match.
 */
function countIdentityMatches(
  mrzNormalized: string,
  allParagraphs: readonly LayoutParagraph[],
  exclude: LayoutParagraph,
): number {
  const seen = new Set<string>();
  for (const p of allParagraphs) {
    if (p === exclude) continue;
    const token = normalizeLettersOnly(p.text);
    if (token.length < MIN_IDENTITY_TOKEN_LENGTH) continue;
    if (seen.has(token)) continue;
    if (mrzNormalized.includes(token)) seen.add(token);
  }
  return seen.size;
}

/**
 * Geometry-primary MRZ location: finds the passport's printed MRZ band from
 * Vision DOCUMENT_TEXT_DETECTION paragraph geometry alone — shape (starts
 * with "P<", very wide, near the page bottom, a long [A-Z0-9<] run, a
 * TD3-plausible merged length) plus an identity cross-check against the
 * page's OTHER paragraphs. The existing checksum-based
 * findMrzCandidateWindows/selectMrzCandidateWinner result (`checksumValidated`)
 * is a SECONDARY signal only: passing it true always yields HIGH confidence
 * (strongest possible corroboration), but its ABSENCE or failure never
 * rejects an otherwise strong geometry+identity match — this is the whole
 * point of this module (see 381's real diagnostic: checksum validation
 * doesn't even structurally parse, yet geometry+identity independently
 * confirm the exact same real MRZ paragraph).
 *
 * False-positive guards: a short paragraph (a lone "P" or "F", the bug this
 * engagement's own earlier automated-matching attempts hit) is excluded by
 * MIN_TEXT_LENGTH; anything above the page's bottom half, or narrower than
 * half the page width, is excluded outright — MRZ is architecturally always
 * near-full-width and near the bottom on a TD3 passport. Returns null —
 * never a guessed position — when no candidate survives these filters.
 */
export function locateMrzParagraphGeometry(
  paragraphs: readonly LayoutParagraph[],
  pageWidth: number,
  pageHeight: number,
  checksumValidated = false,
): MrzGeometryResult | null {
  if (pageWidth <= 0 || pageHeight <= 0) return null;

  const candidates = paragraphs.filter((p) => {
    const normalized = normalizeForMatch(p.text);
    if (normalized.length < MIN_TEXT_LENGTH) return false;
    if (p.y0 < MIN_Y0_FRACTION_HARD * pageHeight) return false;
    if (p.x1 - p.x0 < MIN_WIDTH_FRACTION * pageWidth) return false;
    const startsWithP = normalized.startsWith('P<');
    const longRun = LONG_ALPHABET_RUN_PATTERN.test(normalized);
    if (!startsWithP && !longRun) return false;
    return true;
  });

  if (candidates.length === 0) return null;

  // Prefer the lowest (most bottom-of-page) candidate when more than one survives the filters.
  const best = candidates.reduce((a, b) => (b.y0 > a.y0 ? b : a));

  const normalized = normalizeForMatch(best.text);
  const startsWithP = normalized.startsWith('P<');
  const widthRatio = (best.x1 - best.x0) / pageWidth;
  const y0Ratio = best.y0 / pageHeight;
  const longRun = LONG_ALPHABET_RUN_PATTERN.test(normalized);
  const plausibleLength = normalized.length >= PLAUSIBLE_LENGTH_MIN && normalized.length <= PLAUSIBLE_LENGTH_MAX;

  const identityMatches = countIdentityMatches(normalized, paragraphs, best);
  const identityConsistent = identityMatches >= MIN_IDENTITY_MATCHES;

  const strongShape =
    startsWithP && longRun && widthRatio >= MIN_WIDTH_FRACTION_STRONG && y0Ratio >= MIN_Y0_FRACTION_STRONG;

  let score = 0;
  if (startsWithP) score += 1;
  if (widthRatio >= MIN_WIDTH_FRACTION_STRONG) score += 1;
  if (y0Ratio >= MIN_Y0_FRACTION_STRONG) score += 1;
  if (longRun) score += 1;
  if (plausibleLength) score += 1;

  let confidence: MrzGeometryConfidence;
  if (checksumValidated) {
    confidence = 'HIGH';
  } else if (identityConsistent && (strongShape || (startsWithP && longRun && widthRatio >= MIN_WIDTH_FRACTION))) {
    confidence = 'HIGH';
  } else if (score >= 3) {
    confidence = 'MEDIUM';
  } else {
    confidence = 'LOW';
  }

  return { top: best.y0, confidence, paragraph: best };
}
