import { cropRegion } from '../mrz/cropRegion.js';
import { ENHANCED_FALLBACK_ATTEMPTS } from '../mrz/enhancedFallbackAttempts.js';
import { extractMrzLines } from '../mrz/extractMrzLines.js';
import { findMrzCandidateRegions } from '../mrz/findMrzCandidateRegions.js';
import { DESKEW_FALLBACK_ATTEMPTS, TRIM_FALLBACK_ATTEMPTS } from '../mrz/geometryFallbackAttempts.js';
import { getImageDimensions } from '../mrz/getImageDimensions.js';
import { buildUnreadableMrzResult, mapMrzToExtractionResult } from '../mrz/mapMrzToExtractionResult.js';
import { parseAndValidateMrz } from '../mrz/parseAndValidateMrz.js';
import { runTesseractOcr } from '../mrz/runTesseractOcr.js';
import { searchMrzLines } from '../mrz/searchMrzLines.js';
import { splitLineOcr } from '../mrz/splitLineOcr.js';
import type { PassportExtractionResult } from '../passportExtractionSchema.js';
import { runVisualFieldOcr } from '../visual/runVisualFieldOcr.js';
import type { OcrProvider } from './types.js';

export interface LocalProviderDependencies {
  searchMrzLines: typeof searchMrzLines;
  cropRegion: typeof cropRegion;
  runTesseractOcr: typeof runTesseractOcr;
  getImageDimensions: typeof getImageDimensions;
  runVisualFieldOcr: typeof runVisualFieldOcr;
}

const defaultDependencies: LocalProviderDependencies = {
  searchMrzLines,
  cropRegion,
  runTesseractOcr,
  getImageDimensions,
  runVisualFieldOcr,
};

type MrzStageName = 'search' | 'fallback-plain' | 'fallback-binarized' | 'fallback-split' | 'enhanced' | 'localized' | 'deskew';

/**
 * Diagnostic-only: structural shape of one fallback stage's OCR attempt
 * (which candidate region, which stage, line count, each line's length,
 * whether it parsed) — never the OCR'd text itself. Lets a failed pipeline
 * run be root-caused from logs alone (e.g. "candidate 0 got closest but
 * candidate 2 never got a chance" vs "no lines at all anywhere") without
 * needing the source passport image.
 */
function logMrzStageAttempt(
  stage: MrzStageName,
  attempt: number,
  candidateIndex: number,
  lines: readonly string[],
  parseSuccess: boolean,
): void {
  console.log(
    `[mrz-pipeline] candidate=${candidateIndex} stage=${stage} attempt=${attempt} lineCount=${lines.length} lengths=[${lines.map((line) => line.length).join(',')}] parseSuccess=${parseSuccess}`,
  );
}

/** Diagnostic-only: which stage (if any) ultimately produced the result. */
function logMrzPipelineWinner(stage: MrzStageName | 'none'): void {
  console.log(`[mrz-pipeline] winner=${stage}`);
}

/**
 * Diagnostic-only: same shape as logMrzStageAttempt, plus the scale/
 * threshold this enhanced attempt used — both plain numbers, never OCR'd
 * text or a passport value.
 */
function logEnhancedAttempt(
  attempt: number,
  candidateIndex: number,
  scale: number,
  threshold: number | undefined,
  lines: readonly string[],
  parseSuccess: boolean,
): void {
  console.log(
    `[mrz-pipeline] candidate=${candidateIndex} stage=enhanced attempt=${attempt} scale=${scale} threshold=${threshold ?? 'none'} lineCount=${lines.length} lengths=[${lines.map((line) => line.length).join(',')}] parseSuccess=${parseSuccess}`,
  );
}

/** Diagnostic-only: same shape as logMrzStageAttempt, plus which trim/binarize combination this localized attempt used. */
function logLocalizedAttempt(
  attempt: number,
  candidateIndex: number,
  binarize: boolean,
  lines: readonly string[],
  parseSuccess: boolean,
): void {
  console.log(
    `[mrz-pipeline] candidate=${candidateIndex} stage=localized attempt=${attempt} trim=true binarize=${binarize} lineCount=${lines.length} lengths=[${lines.map((line) => line.length).join(',')}] parseSuccess=${parseSuccess}`,
  );
}

/** Diagnostic-only: same shape as logMrzStageAttempt, plus the rotation angle this deskew attempt used. */
function logDeskewAttempt(
  attempt: number,
  candidateIndex: number,
  rotateDegrees: number,
  lines: readonly string[],
  parseSuccess: boolean,
): void {
  console.log(
    `[mrz-pipeline] candidate=${candidateIndex} stage=deskew attempt=${attempt} rotateDegrees=${rotateDegrees} lineCount=${lines.length} lengths=[${lines.map((line) => line.length).join(',')}] parseSuccess=${parseSuccess}`,
  );
}

/**
 * Best-effort add-on stage, run only after a successful MRZ read: tries to
 * recover passport_issue_date from the passport's visual (non-MRZ) text.
 * Never overrides a value the MRZ result already has, and — since
 * runVisualFieldOcr never throws — never turns a working MRZ result into a
 * failure.
 */
async function enrichWithVisualIssueDate(
  result: PassportExtractionResult,
  imageBuffer: Buffer,
  runVisualFieldOcrDep: LocalProviderDependencies['runVisualFieldOcr'],
): Promise<PassportExtractionResult> {
  if (result.passportIssueDate.value !== null) return result;

  const known = [result.dateOfBirth.value, result.passportExpiryDate.value].filter(
    (value): value is string => value !== null,
  );

  let issueDate: string | null;
  try {
    // runVisualFieldOcr already catches its own errors and resolves to
    // null, but this stage must never break the MRZ result it enriches
    // even if an injected/future implementation doesn't uphold that.
    issueDate = await runVisualFieldOcrDep(imageBuffer, known);
  } catch {
    return result;
  }
  if (issueDate === null) return result;

  return { ...result, passportIssueDate: { value: issueDate, confidence: 'medium' } };
}

/**
 * Free, on-server passport MRZ extraction. Never calls any external API —
 * everything here runs as a local process/library on this machine. Never
 * guesses: an unreadable/invalid MRZ produces an all-null, low-confidence
 * result instead of throwing or inventing data.
 *
 * Staged, bounded pipeline (each stage only runs if the previous one
 * didn't produce a genuinely checksum-parseable MRZ):
 *   1. searchMrzLines — the primary strategy: tries a small, bounded set
 *      of candidate crop regions (not a single fixed guess) with plain
 *      preprocessing, since a fixed percentage isn't reliable across
 *      photos framed differently.
 *   2. For EACH of those same candidate regions (tightest-first — see
 *      findMrzCandidateRegions.ts), in turn: binarized, split-line,
 *      enhanced (stronger upscale/threshold — enhancedFallbackAttempts.ts),
 *      localized (trim to ink content), and deskew (small rotation angles
 *      — geometryFallbackAttempts.ts) OCR attempts, stopping at the first
 *      one that produces a genuinely checksum-parseable MRZ.
 *
 * Production evidence showed the *tightest* search candidate sometimes
 * scores closer to a genuine 44-character MRZ line than the old single
 * fixed (bottom-60%) fallback crop, but was previously discarded after
 * just one plain OCR attempt — every richer preprocessing variant only
 * ever ran against that one looser, fixed region. Now every candidate
 * gets the full preprocessing chain before falling through to the next,
 * so a promising but imperfect region isn't abandoned prematurely.
 *
 * Bounded, not unbounded: each candidate gets exactly 1 (binarized) + 1
 * (split, itself 2 OCR calls) + ENHANCED_FALLBACK_ATTEMPTS.length +
 * TRIM_FALLBACK_ATTEMPTS.length + DESKEW_FALLBACK_ATTEMPTS.length OCR
 * attempts, times the fixed number of candidates findMrzCandidateRegions
 * returns — a fixed, enumerable total.
 */
export function createLocalProvider(deps: LocalProviderDependencies = defaultDependencies): OcrProvider {
  return {
    name: 'local',
    async extract(imageBuffer: Buffer): Promise<PassportExtractionResult> {
      const searchResult = await deps.searchMrzLines(imageBuffer, {
        cropRegion: deps.cropRegion,
        runTesseractOcr: deps.runTesseractOcr,
      });
      if (searchResult) {
        logMrzPipelineWinner('search');
        return enrichWithVisualIssueDate(
          mapMrzToExtractionResult(searchResult.parsed, searchResult.lines),
          imageBuffer,
          deps.runVisualFieldOcr,
        );
      }

      const { width, height } = await deps.getImageDimensions(imageBuffer);
      const candidates = findMrzCandidateRegions(width, height);

      let attemptNumber = 2;
      let lastAttemptedLines: string[] = [];

      for (const [candidateIndex, candidate] of candidates.entries()) {
        const { top: candidateTop, height: candidateHeight } = candidate;

        // Binarized — plain was already tried for this exact region by
        // searchMrzLines above, no need to repeat it.
        const binarizedCrop = await deps.cropRegion(imageBuffer, candidateTop, candidateHeight, { binarize: true });
        const binarizedText = await deps.runTesseractOcr(binarizedCrop, { psm: 6, oem: 1 });
        const binarizedLines = extractMrzLines(binarizedText);
        lastAttemptedLines = binarizedLines;
        let parsed = parseAndValidateMrz(binarizedLines);
        logMrzStageAttempt('fallback-binarized', attemptNumber++, candidateIndex, binarizedLines, parsed !== null);
        if (parsed) {
          logMrzPipelineWinner('fallback-binarized');
          return enrichWithVisualIssueDate(mapMrzToExtractionResult(parsed, binarizedLines), imageBuffer, deps.runVisualFieldOcr);
        }

        // Split-line: this candidate's two lines OCR'd separately.
        const splitLines = await splitLineOcr(imageBuffer, candidateTop, candidateHeight, {
          cropRegion: deps.cropRegion,
          runTesseractOcr: deps.runTesseractOcr,
        });
        lastAttemptedLines = splitLines;
        parsed = parseAndValidateMrz(splitLines);
        logMrzStageAttempt('fallback-split', attemptNumber++, candidateIndex, splitLines, parsed !== null);
        if (parsed) {
          logMrzPipelineWinner('fallback-split');
          return enrichWithVisualIssueDate(mapMrzToExtractionResult(parsed, splitLines), imageBuffer, deps.runVisualFieldOcr);
        }

        // Enhanced: stronger preprocessing (larger upscale, alternate
        // binarization thresholds) on this same candidate region.
        for (const attempt of ENHANCED_FALLBACK_ATTEMPTS) {
          const enhancedCrop = await deps.cropRegion(imageBuffer, candidateTop, candidateHeight, {
            binarize: attempt.threshold !== undefined,
            scale: attempt.scale,
            threshold: attempt.threshold,
          });
          const enhancedText = await deps.runTesseractOcr(enhancedCrop, { psm: 6, oem: 1 });
          const enhancedLines = extractMrzLines(enhancedText);
          lastAttemptedLines = enhancedLines;
          parsed = parseAndValidateMrz(enhancedLines);
          logEnhancedAttempt(attemptNumber++, candidateIndex, attempt.scale, attempt.threshold, enhancedLines, parsed !== null);
          if (parsed) {
            logMrzPipelineWinner('enhanced');
            return enrichWithVisualIssueDate(mapMrzToExtractionResult(parsed, enhancedLines), imageBuffer, deps.runVisualFieldOcr);
          }
        }

        // Localized: this candidate region, tightened to its actual ink
        // content via trim() before OCR.
        for (const attempt of TRIM_FALLBACK_ATTEMPTS) {
          const localizedCrop = await deps.cropRegion(imageBuffer, candidateTop, candidateHeight, {
            trim: true,
            binarize: attempt.binarize,
          });
          const localizedText = await deps.runTesseractOcr(localizedCrop, { psm: 6, oem: 1 });
          const localizedLines = extractMrzLines(localizedText);
          lastAttemptedLines = localizedLines;
          parsed = parseAndValidateMrz(localizedLines);
          logLocalizedAttempt(attemptNumber++, candidateIndex, attempt.binarize, localizedLines, parsed !== null);
          if (parsed) {
            logMrzPipelineWinner('localized');
            return enrichWithVisualIssueDate(mapMrzToExtractionResult(parsed, localizedLines), imageBuffer, deps.runVisualFieldOcr);
          }
        }

        // Deskew: this candidate region, rotated by a few small angles.
        // Always binarized (plain vs. binarized already showed no effect
        // independent of preprocessing in the enhanced stage above), so
        // this isolates rotation alone.
        for (const attempt of DESKEW_FALLBACK_ATTEMPTS) {
          const deskewedCrop = await deps.cropRegion(imageBuffer, candidateTop, candidateHeight, {
            rotateDegrees: attempt.rotateDegrees,
            binarize: true,
          });
          const deskewedText = await deps.runTesseractOcr(deskewedCrop, { psm: 6, oem: 1 });
          const deskewedLines = extractMrzLines(deskewedText);
          lastAttemptedLines = deskewedLines;
          parsed = parseAndValidateMrz(deskewedLines);
          logDeskewAttempt(attemptNumber++, candidateIndex, attempt.rotateDegrees, deskewedLines, parsed !== null);
          if (parsed) {
            logMrzPipelineWinner('deskew');
            return enrichWithVisualIssueDate(mapMrzToExtractionResult(parsed, deskewedLines), imageBuffer, deps.runVisualFieldOcr);
          }
        }
      }

      // Nothing worked on any candidate — never guess. Keep the last
      // attempted lines for human review (structurally, not content — see
      // buildUnreadableMrzResult); this is only about which raw text is
      // kept for review, not part of the parsing/confidence logic.
      logMrzPipelineWinner('none');
      return buildUnreadableMrzResult(lastAttemptedLines);
    },
  };
}

export const localProvider: OcrProvider = createLocalProvider();
