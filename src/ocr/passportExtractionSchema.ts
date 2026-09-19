// Uses the zod/v4 subpath specifically: @anthropic-ai/sdk's zodOutputFormat
// helper (v0.127) is typed against `zod/v4`, not the classic `zod` v3 API
// the rest of this app uses (see src/config/env.schema.ts). zod 3.25+
// ships both from the same package, so no extra dependency is needed —
// just this one import path, isolated to the Claude-facing schema.
import { z } from 'zod/v4';

export const CONFIDENCE_LEVELS = ['high', 'medium', 'low'] as const;
export const ConfidenceLevelSchema = z.enum(CONFIDENCE_LEVELS);
export type ConfidenceLevel = z.infer<typeof ConfidenceLevelSchema>;

export const GENDER_VALUES = ['male', 'female', 'unspecified'] as const;
export const GenderValueSchema = z.enum(GENDER_VALUES);
export type GenderValue = z.infer<typeof GenderValueSchema>;

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isRealCalendarDate(value: string): boolean {
  const [year, month, day] = value.split('-').map(Number);
  if (!year || !month || !day) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export const IsoDateStringSchema = z
  .string()
  .regex(ISO_DATE_PATTERN, 'must be formatted as YYYY-MM-DD')
  .refine(isRealCalendarDate, 'must be a real calendar date');

function extractedField<T extends z.ZodType>(valueSchema: T) {
  return z.object({
    value: valueSchema.nullable(),
    confidence: ConfidenceLevelSchema.nullable(),
  });
}

export type ExtractedField<T> = { value: T | null; confidence: ConfidenceLevel | null };

/** The schema Claude's response must satisfy — this is what gets passed to zodOutputFormat(). */
export const ClaudePassportResponseSchema = z.object({
  firstName: extractedField(z.string().min(1)),
  middleName: extractedField(z.string().min(1)),
  surname: extractedField(z.string().min(1)),
  passportNumber: extractedField(z.string().min(1)),
  dateOfBirth: extractedField(IsoDateStringSchema),
  passportIssueDate: extractedField(IsoDateStringSchema),
  passportExpiryDate: extractedField(IsoDateStringSchema),
  gender: extractedField(GenderValueSchema),
  nationality: extractedField(z.string().min(1)),
  placeOfBirth: extractedField(z.string().min(1)),
  issuingAuthority: extractedField(z.string().min(1)),
  mrz: extractedField(z.string().min(1)),
});

export type ClaudePassportResponse = z.infer<typeof ClaudePassportResponseSchema>;

export interface PassportExtractionResult extends ClaudePassportResponse {
  overallConfidence: ConfidenceLevel;
  model: string;
}

export const CRITICAL_FIELDS = [
  'firstName',
  'surname',
  'passportNumber',
  'dateOfBirth',
  'passportIssueDate',
  'passportExpiryDate',
] as const satisfies readonly (keyof ClaudePassportResponse)[];

const CONFIDENCE_RANK: Record<ConfidenceLevel, number> = { low: 0, medium: 1, high: 2 };

/**
 * Deterministic rollup, not an invented score: a document is only as
 * reliable as its least-confident critical field, and a missing critical
 * field forces "low" outright, regardless of what other fields look like.
 *
 * `criticalFields` defaults to CRITICAL_FIELDS (the full set Claude Vision
 * can see) but is overridable — the local MRZ provider passes a reduced set
 * that excludes fields MRZ structurally cannot encode (passportIssueDate,
 * placeOfBirth, issuingAuthority), since always-null-there isn't a quality
 * problem to penalize the way a missing field from a full-page read is.
 */
export function computeOverallConfidence(
  response: ClaudePassportResponse,
  criticalFields: readonly (keyof ClaudePassportResponse)[] = CRITICAL_FIELDS,
): ConfidenceLevel {
  let worst: ConfidenceLevel = 'high';
  for (const field of criticalFields) {
    const { value, confidence } = response[field];
    const effective: ConfidenceLevel = value === null ? 'low' : (confidence ?? 'low');
    if (CONFIDENCE_RANK[effective] < CONFIDENCE_RANK[worst]) {
      worst = effective;
    }
  }
  return worst;
}
