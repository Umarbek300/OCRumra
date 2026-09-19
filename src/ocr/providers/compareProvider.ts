import { env } from '../../config/env.js';
import type { ClaudePassportResponse, PassportExtractionResult } from '../passportExtractionSchema.js';
import { anthropicProvider } from './anthropicProvider.js';
import { localProvider } from './localProvider.js';
import type { OcrProvider } from './types.js';

const COMPARABLE_FIELDS = [
  'firstName',
  'middleName',
  'surname',
  'passportNumber',
  'dateOfBirth',
  'passportIssueDate',
  'passportExpiryDate',
  'gender',
  'nationality',
  'placeOfBirth',
  'issuingAuthority',
  'mrz',
] as const satisfies readonly (keyof ClaudePassportResponse)[];

/**
 * Logs only which fields matched/differed and each side's confidence level
 * — never the actual extracted values (names, passport numbers, dates,
 * etc.), per the same no-PII-in-logs discipline used everywhere else in
 * this pipeline.
 */
function logComparison(local: PassportExtractionResult, anthropic: PassportExtractionResult): void {
  const fieldDiffs = COMPARABLE_FIELDS.map((field) => {
    const matches = local[field].value === anthropic[field].value;
    return `${field}=${matches ? 'match' : 'diff'}(local:${local[field].confidence ?? 'null'},anthropic:${anthropic[field].confidence ?? 'null'})`;
  });
  console.log(
    `[ocr-compare] overallConfidence local=${local.overallConfidence} anthropic=${anthropic.overallConfidence} | ${fieldDiffs.join(' ')}`,
  );
}

export interface CompareProviderDependencies {
  local: OcrProvider;
  anthropic: OcrProvider;
  /** Defaults to env.OCR_COMPARE_WITH_ANTHROPIC — injectable so tests never depend on process env. */
  compareWithAnthropic: boolean;
}

const defaultDependencies: CompareProviderDependencies = {
  local: localProvider,
  anthropic: anthropicProvider,
  compareWithAnthropic: env.OCR_COMPARE_WITH_ANTHROPIC,
};

/**
 * Always runs the free local provider and treats it as authoritative (its
 * result is what gets returned/stored). Only also runs Anthropic — and
 * only then logs a field-level diff — when OCR_COMPARE_WITH_ANTHROPIC is
 * explicitly true, so compare mode never silently spends API credits.
 */
export function createCompareProvider(deps: CompareProviderDependencies = defaultDependencies): OcrProvider {
  return {
    name: 'local',
    async extract(imageBuffer: Buffer, mimeType: string): Promise<PassportExtractionResult> {
      const local = await deps.local.extract(imageBuffer, mimeType);

      if (!deps.compareWithAnthropic) {
        return local;
      }

      try {
        const anthropic = await deps.anthropic.extract(imageBuffer, mimeType);
        logComparison(local, anthropic);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown error';
        console.log(`[ocr-compare] Anthropic comparison run failed (local result still used): ${message}`);
      }

      return local;
    },
  };
}

export const compareProvider: OcrProvider = createCompareProvider();
