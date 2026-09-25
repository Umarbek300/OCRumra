import type { Details, FieldName, ParseResult } from 'mrz';
import {
  computeOverallConfidence,
  CRITICAL_FIELDS,
  type ClaudePassportResponse,
  type ConfidenceLevel,
  type ExtractedField,
  type PassportExtractionResult,
} from '../passportExtractionSchema.js';
import { normalizeMrzDate } from './normalizeMrzDate.js';

export const LOCAL_PROVIDER_MODEL = 'tesseract-mrz-local';

/**
 * MRZ structurally cannot encode these — TD3 (passport) MRZ has no field
 * for issue date, place of birth, or a human-readable issuing authority
 * name. They stay { value: null, confidence: null } always: never guessed.
 * Excluded from the local provider's confidence rollup below (approved) so
 * a structural gap doesn't masquerade as a quality problem the way a
 * missing field from a full-page read would.
 */
const LOCAL_CRITICAL_FIELDS = CRITICAL_FIELDS.filter(
  (field) => field !== 'passportIssueDate',
) as readonly (keyof ClaudePassportResponse)[];

function findDetail(details: readonly Details[], field: FieldName): Details | undefined {
  return details.find((detail) => detail.field === field);
}

function nullField<T>(): ExtractedField<T> {
  return { value: null, confidence: null };
}

/**
 * For fields with no MRZ check digit (names, sex, nationality, issuing
 * state code). Confidence reflects only that field's own validity, not the
 * document's overall validity — an unrelated field failing (e.g. a state
 * code the library's static list doesn't recognize) shouldn't drag down
 * confidence in a field that parsed and validated fine on its own.
 */
function structuralField<T>(value: T | null, detail: Details | undefined): ExtractedField<T> {
  if (value === null || value === undefined) return nullField();
  const structurallyValid = detail?.valid ?? false;
  return { value, confidence: structurallyValid ? 'medium' : 'low' };
}

/** For fields protected by their own MRZ check digit (document number, birth date, expiry date). */
function checksummedField<T>(
  value: T | null,
  checkDigitDetail: Details | undefined,
  compositeDetail: Details | undefined,
): ExtractedField<T> {
  if (value === null || value === undefined) return nullField();
  const checkDigitValid = checkDigitDetail?.valid ?? false;
  const compositeValid = compositeDetail?.valid ?? false;
  return { value, confidence: checkDigitValid && compositeValid ? 'high' : 'low' };
}

function mapSex(rawSex: string | null): 'male' | 'female' | 'unspecified' | null {
  if (rawSex === 'male' || rawSex === 'female') return rawSex;
  if (rawSex === 'nonspecified') return 'unspecified';
  return null;
}

/** MRZ gives given names as one space-joined block; splits it into first + remaining (middle). */
function splitGivenNames(rawFirstName: string | null): { firstName: string | null; middleName: string | null } {
  if (!rawFirstName) return { firstName: null, middleName: null };
  const parts = rawFirstName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: null, middleName: null };
  return { firstName: parts[0] ?? null, middleName: parts.length > 1 ? parts.slice(1).join(' ') : null };
}

/**
 * Maps a validated `mrz` ParseResult (TD3 passport MRZ) onto the same
 * ClaudePassportResponse shape the Anthropic provider produces, so the rest
 * of the pipeline (performPassportOcr, passport_ocr_results, tests) never
 * needs to know which provider ran. Every value is either something the
 * MRZ actually encoded, or null — nothing is invented.
 */
export function mapMrzToExtractionResult(
  result: ParseResult,
  rawMrzLines: readonly string[],
  model: string = LOCAL_PROVIDER_MODEL,
  visualIssueDate: string | null = null,
): PassportExtractionResult {
  const { fields, details, valid: overallValid } = result;
  const compositeDetail = findDetail(details, 'compositeCheckDigit');

  const { firstName, middleName } = splitGivenNames(fields.firstName ?? null);

  const response: ClaudePassportResponse = {
    firstName: structuralField(firstName, findDetail(details, 'firstName')),
    middleName: middleName ? structuralField(middleName, findDetail(details, 'firstName')) : nullField(),
    surname: structuralField(fields.lastName ?? null, findDetail(details, 'lastName')),
    passportNumber: checksummedField(
      fields.documentNumber ?? null,
      findDetail(details, 'documentNumberCheckDigit'),
      compositeDetail,
    ),
    dateOfBirth: checksummedField(
      normalizeMrzDate(fields.birthDate, 'birth'),
      findDetail(details, 'birthDateCheckDigit'),
      compositeDetail,
    ),
    // Not encoded in MRZ — a caller (e.g. the Google Vision provider) may
    // supply an already-extracted, already-validated visual-zone date
    // instead; never invented here. No MRZ check digit exists for it, so
    // it can only ever be 'medium' — matching the same policy
    // localProvider.ts's enrichWithVisualIssueDate() already uses.
    passportIssueDate: visualIssueDate !== null ? { value: visualIssueDate, confidence: 'medium' } : nullField(),
    passportExpiryDate: checksummedField(
      normalizeMrzDate(fields.expirationDate, 'expiry'),
      findDetail(details, 'expirationDateCheckDigit'),
      compositeDetail,
    ),
    gender: structuralField(mapSex(fields.sex ?? null), findDetail(details, 'sex')),
    nationality: structuralField(fields.nationality ?? null, findDetail(details, 'nationality')),
    // Not encoded in MRZ — never guessed.
    placeOfBirth: nullField(),
    // MRZ has no human-readable authority name — the closest structurally
    // present fact is the 3-letter issuing-state code, surfaced here rather
    // than left permanently empty. Not the printed authority text.
    issuingAuthority: structuralField(fields.issuingState ?? null, findDetail(details, 'issuingState')),
    mrz: { value: rawMrzLines.join('\n'), confidence: overallValid ? 'high' : 'low' },
  };

  const overallConfidence: ConfidenceLevel = computeOverallConfidence(response, LOCAL_CRITICAL_FIELDS);

  return { ...response, overallConfidence, model };
}

/**
 * The MRZ-derived dates (dateOfBirth, passportExpiryDate) already known for
 * this document, in ISO form, regardless of their checksum confidence —
 * used as a safety check so a visual-zone issue-date extractor never
 * echoes back a date that's actually the birth or expiry date under a
 * different, mislabeled field.
 */
export function getKnownCriticalDates(result: ParseResult): string[] {
  const { fields } = result;
  return [normalizeMrzDate(fields.birthDate, 'birth'), normalizeMrzDate(fields.expirationDate, 'expiry')].filter(
    (value): value is string => value !== null,
  );
}

/**
 * Used when the OCR'd text isn't even a recognizable MRZ shape (wrong line
 * count/length — a bad photo, wrong crop, or OCR garbage). Every field is
 * null except the raw OCR text itself, which is kept for human review —
 * that's not a guess, it's exactly what was read, just flagged unreliable.
 */
export function buildUnreadableMrzResult(rawOcrLines: readonly string[], model: string = LOCAL_PROVIDER_MODEL): PassportExtractionResult {
  const response: ClaudePassportResponse = {
    firstName: nullField(),
    middleName: nullField(),
    surname: nullField(),
    passportNumber: nullField(),
    dateOfBirth: nullField(),
    passportIssueDate: nullField(),
    passportExpiryDate: nullField(),
    gender: nullField(),
    nationality: nullField(),
    placeOfBirth: nullField(),
    issuingAuthority: nullField(),
    mrz: rawOcrLines.length > 0 ? { value: rawOcrLines.join('\n'), confidence: 'low' } : nullField(),
  };
  return { ...response, overallConfidence: 'low', model };
}
