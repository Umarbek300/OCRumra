import { cropRegion } from '../mrz/cropRegion.js';
import { extractMrzLines } from '../mrz/extractMrzLines.js';
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

type MrzStageName = 'search' | 'fallback-plain' | 'fallback-binarized' | 'fallback-split';

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
 * Stages 2-4 share one crop region, so this stays bounded: at most 3
 * search attempts + 4 fallback OCR calls, not an unbounded search.
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
      const fallbackText = await deps.runTesseractOcr(fallbackCrop, { psm: 6 });
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
      const binarizedText = await deps.runTesseractOcr(binarizedCrop, { psm: 6 });
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

      // Nothing worked — never guess. Keep whichever attempt's raw text
      // for human review (structurally, not content — see buildUnreadableMrzResult).
      logMrzPipelineWinner('none');
      return buildUnreadableMrzResult(binarizedLines.length > 0 ? binarizedLines : fallbackLines);
    },
  };
}

export const localProvider: OcrProvider = createLocalProvider();
