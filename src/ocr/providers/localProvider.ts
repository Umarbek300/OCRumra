import { cropRegion } from '../mrz/cropRegion.js';
import { ENHANCED_FALLBACK_ATTEMPTS } from '../mrz/enhancedFallbackAttempts.js';
import { extractMrzLines } from '../mrz/extractMrzLines.js';
import { DESKEW_FALLBACK_ATTEMPTS, TRIM_FALLBACK_ATTEMPTS } from '../mrz/geometryFallbackAttempts.js';
import { getImageDimensions } from '../mrz/getImageDimensions.js';
import { FALLBACK_CROP_BOTTOM_FRACTION, locateMrzRegion } from '../mrz/locateMrzRegion.js';
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
  locateMrzRegion: typeof locateMrzRegion;
  cropRegion: typeof cropRegion;
  runTesseractOcr: typeof runTesseractOcr;
  getImageDimensions: typeof getImageDimensions;
  runVisualFieldOcr: typeof runVisualFieldOcr;
}

const defaultDependencies: LocalProviderDependencies = {
  searchMrzLines,
  locateMrzRegion,
  cropRegion,
  runTesseractOcr,
  getImageDimensions,
  runVisualFieldOcr,
};

type MrzStageName = 'search' | 'fallback-plain' | 'fallback-binarized' | 'fallback-split' | 'enhanced' | 'localized' | 'deskew';

/**
 * Diagnostic-only: structural shape of one fallback stage's OCR attempt
 * (which stage, line count, each line's length, whether it parsed) — never
 * the OCR'd text itself. Lets a failed pipeline run be root-caused from
 * logs alone (e.g. "line length off by 2" vs "no lines at all") without
 * needing the source passport image.
 */
function logMrzStageAttempt(stage: MrzStageName, attempt: number, lines: readonly string[], parseSuccess: boolean): void {
  console.log(
    `[mrz-pipeline] stage=${stage} attempt=${attempt} lineCount=${lines.length} lengths=[${lines.map((line) => line.length).join(',')}] parseSuccess=${parseSuccess}`,
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
  scale: number,
  threshold: number | undefined,
  lines: readonly string[],
  parseSuccess: boolean,
): void {
  console.log(
    `[mrz-pipeline] stage=enhanced attempt=${attempt} scale=${scale} threshold=${threshold ?? 'none'} lineCount=${lines.length} lengths=[${lines.map((line) => line.length).join(',')}] parseSuccess=${parseSuccess}`,
  );
}

/** Diagnostic-only: same shape as logMrzStageAttempt, plus which trim/binarize combination this localized attempt used. */
function logLocalizedAttempt(attempt: number, binarize: boolean, lines: readonly string[], parseSuccess: boolean): void {
  console.log(
    `[mrz-pipeline] stage=localized attempt=${attempt} trim=true binarize=${binarize} lineCount=${lines.length} lengths=[${lines.map((line) => line.length).join(',')}] parseSuccess=${parseSuccess}`,
  );
}

/** Diagnostic-only: same shape as logMrzStageAttempt, plus the rotation angle this deskew attempt used. */
function logDeskewAttempt(attempt: number, rotateDegrees: number, lines: readonly string[], parseSuccess: boolean): void {
  console.log(
    `[mrz-pipeline] stage=deskew attempt=${attempt} rotateDegrees=${rotateDegrees} lineCount=${lines.length} lengths=[${lines.map((line) => line.length).join(',')}] parseSuccess=${parseSuccess}`,
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
 *      of candidate crop regions (not a single fixed guess), since a
 *      fixed percentage isn't reliable across photos framed differently.
 *   2. The original fixed bottom-40% crop (locateMrzRegion, unchanged),
 *      as a fallback — same combined-block OCR as before.
 *   3. The same fallback region, binarized (thresholded) — helps on
 *      uneven lighting plain contrast-stretching doesn't fix.
 *   4. The same fallback region, with its two lines OCR'd *separately*
 *      (single-line PSM) — avoids multi-line block segmentation errors.
 *   5. The same region again, through a bounded, fixed set of stronger
 *      preprocessing variants (larger upscale, alternate binarization
 *      thresholds — see enhancedFallbackAttempts.ts) for images where 2x/
 *      150 genuinely isn't enough resolution/contrast for Tesseract.
 *   6. The same region, tightened to its actual ink content (trim) —
 *      tests whether blank margin/border inside the crop was confusing
 *      Tesseract's line segmentation (see geometryFallbackAttempts.ts).
 *   7. The same region, rotated by a few small angles (deskew) — tests
 *      whether a slight camera tilt was breaking line recognition
 *      (see geometryFallbackAttempts.ts).
 * Stages 2-7 share one crop region, so this stays bounded: at most 3
 * search attempts + 4 fallback OCR calls + ENHANCED_FALLBACK_ATTEMPTS.length
 * + TRIM_FALLBACK_ATTEMPTS.length + DESKEW_FALLBACK_ATTEMPTS.length OCR
 * calls — a fixed, enumerable total, not an unbounded search.
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

      // Fallback stage 2: original fixed crop, plain, combined-block OCR.
      const fallbackCrop = await deps.locateMrzRegion(imageBuffer);
      const fallbackText = await deps.runTesseractOcr(fallbackCrop, { psm: 6, oem: 1 });
      const fallbackLines = extractMrzLines(fallbackText);
      let parsed = parseAndValidateMrz(fallbackLines);
      logMrzStageAttempt('fallback-plain', 2, fallbackLines, parsed !== null);
      if (parsed) {
        logMrzPipelineWinner('fallback-plain');
        return enrichWithVisualIssueDate(mapMrzToExtractionResult(parsed, fallbackLines), imageBuffer, deps.runVisualFieldOcr);
      }

      // Fallback stage 3: same region, binarized.
      const { height } = await deps.getImageDimensions(imageBuffer);
      const fallbackTop = Math.round(height * FALLBACK_CROP_BOTTOM_FRACTION);
      const fallbackHeight = height - fallbackTop;

      const binarizedCrop = await deps.cropRegion(imageBuffer, fallbackTop, fallbackHeight, { binarize: true });
      const binarizedText = await deps.runTesseractOcr(binarizedCrop, { psm: 6, oem: 1 });
      const binarizedLines = extractMrzLines(binarizedText);
      parsed = parseAndValidateMrz(binarizedLines);
      logMrzStageAttempt('fallback-binarized', 3, binarizedLines, parsed !== null);
      if (parsed) {
        logMrzPipelineWinner('fallback-binarized');
        return enrichWithVisualIssueDate(mapMrzToExtractionResult(parsed, binarizedLines), imageBuffer, deps.runVisualFieldOcr);
      }

      // Fallback stage 4: same region, lines OCR'd separately.
      const splitLines = await splitLineOcr(imageBuffer, fallbackTop, fallbackHeight, {
        cropRegion: deps.cropRegion,
        runTesseractOcr: deps.runTesseractOcr,
      });
      parsed = parseAndValidateMrz(splitLines);
      logMrzStageAttempt('fallback-split', 4, splitLines, parsed !== null);
      if (parsed) {
        logMrzPipelineWinner('fallback-split');
        return enrichWithVisualIssueDate(mapMrzToExtractionResult(parsed, splitLines), imageBuffer, deps.runVisualFieldOcr);
      }

      // Enhanced fallback: the same region as stages 2-4, but with
      // stronger preprocessing (larger upscale, alternate binarization
      // thresholds) than the original 2x/150 pipeline. A bounded, fixed
      // list (ENHANCED_FALLBACK_ATTEMPTS) — not a dynamic cross-product —
      // tried only after every original stage has already failed.
      for (const [index, attempt] of ENHANCED_FALLBACK_ATTEMPTS.entries()) {
        const enhancedCrop = await deps.cropRegion(imageBuffer, fallbackTop, fallbackHeight, {
          binarize: attempt.threshold !== undefined,
          scale: attempt.scale,
          threshold: attempt.threshold,
        });
        const enhancedText = await deps.runTesseractOcr(enhancedCrop, { psm: 6, oem: 1 });
        const enhancedLines = extractMrzLines(enhancedText);
        parsed = parseAndValidateMrz(enhancedLines);
        logEnhancedAttempt(5 + index, attempt.scale, attempt.threshold, enhancedLines, parsed !== null);
        if (parsed) {
          logMrzPipelineWinner('enhanced');
          return enrichWithVisualIssueDate(mapMrzToExtractionResult(parsed, enhancedLines), imageBuffer, deps.runVisualFieldOcr);
        }
      }

      // Localized fallback: the same region, tightened to its actual ink
      // content via trim() before OCR — tests whether blank margin/border
      // inside the crop was confusing Tesseract's line segmentation,
      // rather than resolution/threshold (already fully explored above
      // with no effect). A bounded, fixed list, tried only after every
      // prior stage has failed.
      const localizedAttemptStart = 5 + ENHANCED_FALLBACK_ATTEMPTS.length;
      for (const [index, attempt] of TRIM_FALLBACK_ATTEMPTS.entries()) {
        const localizedCrop = await deps.cropRegion(imageBuffer, fallbackTop, fallbackHeight, {
          trim: true,
          binarize: attempt.binarize,
        });
        const localizedText = await deps.runTesseractOcr(localizedCrop, { psm: 6, oem: 1 });
        const localizedLines = extractMrzLines(localizedText);
        parsed = parseAndValidateMrz(localizedLines);
        logLocalizedAttempt(localizedAttemptStart + index, attempt.binarize, localizedLines, parsed !== null);
        if (parsed) {
          logMrzPipelineWinner('localized');
          return enrichWithVisualIssueDate(mapMrzToExtractionResult(parsed, localizedLines), imageBuffer, deps.runVisualFieldOcr);
        }
      }

      // Deskew fallback: the same region, rotated by a few small angles —
      // tests whether a slight camera tilt was breaking line recognition.
      // Always binarized (plain vs. binarized already showed no effect
      // independent of preprocessing in the enhanced stage above), so
      // this isolates rotation alone. A bounded, fixed list of angles,
      // tried only after every prior stage has failed.
      const deskewAttemptStart = localizedAttemptStart + TRIM_FALLBACK_ATTEMPTS.length;
      for (const [index, attempt] of DESKEW_FALLBACK_ATTEMPTS.entries()) {
        const deskewedCrop = await deps.cropRegion(imageBuffer, fallbackTop, fallbackHeight, {
          rotateDegrees: attempt.rotateDegrees,
          binarize: true,
        });
        const deskewedText = await deps.runTesseractOcr(deskewedCrop, { psm: 6, oem: 1 });
        const deskewedLines = extractMrzLines(deskewedText);
        parsed = parseAndValidateMrz(deskewedLines);
        logDeskewAttempt(deskewAttemptStart + index, attempt.rotateDegrees, deskewedLines, parsed !== null);
        if (parsed) {
          logMrzPipelineWinner('deskew');
          return enrichWithVisualIssueDate(mapMrzToExtractionResult(parsed, deskewedLines), imageBuffer, deps.runVisualFieldOcr);
        }
      }

      // Nothing worked — never guess. Keep whichever attempt's raw text
      // for human review (structurally, not content — see buildUnreadableMrzResult).
      // Unchanged from before the enhanced/localized/deskew stages were
      // added: still prefers the binarized (stage 3) or plain (stage 2)
      // attempt — this is only about which raw text is kept for human
      // review, not part of the parsing/confidence logic.
      logMrzPipelineWinner('none');
      return buildUnreadableMrzResult(binarizedLines.length > 0 ? binarizedLines : fallbackLines);
    },
  };
}

export const localProvider: OcrProvider = createLocalProvider();
