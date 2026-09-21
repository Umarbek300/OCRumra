import { runTesseractOcr } from '../mrz/runTesseractOcr.js';
import { extractDateCandidates } from './extractDateCandidates.js';
import { inferIssueDate } from './inferIssueDate.js';
import { locateVisualZone } from './locateVisualZone.js';

export interface RunVisualFieldOcrDependencies {
  locateVisualZone: typeof locateVisualZone;
  runTesseractOcr: typeof runTesseractOcr;
}

const defaultDependencies: RunVisualFieldOcrDependencies = {
  locateVisualZone,
  runTesseractOcr,
};

/**
 * Best-effort add-on that runs strictly after a successful MRZ read: OCRs
 * the visual (non-MRZ) zone of the passport page and tries to recover
 * passport_issue_date by elimination against dates MRZ already validated
 * (`known`, e.g. dateOfBirth/passportExpiryDate). Never throws — any
 * failure here (bad crop, missing tesseract, ambiguous OCR text) must never
 * break the MRZ result it's enriching, so every error path resolves to
 * `null` instead of propagating.
 */
export async function runVisualFieldOcr(
  imageBuffer: Buffer,
  known: string[],
  deps: RunVisualFieldOcrDependencies = defaultDependencies,
): Promise<string | null> {
  try {
    const visualZone = await deps.locateVisualZone(imageBuffer);
    const text = await deps.runTesseractOcr(visualZone, { psm: 6, useWhitelist: false });
    const candidates = extractDateCandidates(text);
    const issueDate = inferIssueDate(candidates, known);

    // Diagnostic only: counts/booleans, never the OCR text or actual dates.
    console.log(`[visual-issue-date] candidateDateCount=${candidates.length} resolved=${issueDate !== null}`);

    return issueDate;
  } catch (error) {
    console.log(`[visual-issue-date] failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    return null;
  }
}
