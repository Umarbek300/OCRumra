import type { Agent } from '../db/repositories/agents.repo.js';
import type { OcrField, OcrGenderValue, PassportOcrResultRecord } from '../db/repositories/passportOcrResult.repo.js';

/** № + 11 data columns, in the exact approved order. */
export const SHEET_ROW_COLUMN_COUNT = 12;

export interface BuildSheetRowInput {
  ocrResult: Pick<
    PassportOcrResultRecord,
    'firstName' | 'surname' | 'passportNumber' | 'dateOfBirth' | 'passportIssueDate' | 'passportExpiryDate' | 'gender'
  >;
  /** The Telegram sender who sent the passport photo — this pipeline's only current notion of "agent" for a customer. */
  agent: Pick<Agent, 'name'> | null;
}

function fieldValue(field: OcrField): string {
  return field.value ?? '';
}

const GENDER_LABELS: Record<OcrGenderValue, string> = {
  male: 'Erkak',
  female: 'Ayol',
  unspecified: '',
};

function genderLabel(gender: OcrField<OcrGenderValue>): string {
  return gender.value !== null ? GENDER_LABELS[gender.value] : '';
}

/**
 * Builds one Google Sheet row from an OCR result and the agent who sent
 * the passport photo. Pure and side-effect free — no Google API call, no
 * DB query. Column order matches the approved 12-column schema exactly:
 * №, Ism, Familiya, Passport №, Tug'ilgan sana, Berilgan sana, Amal qilish
 * sanasi, Jins, Agent, Paket, Depozit, Qoldiq.
 *
 * № is always '' here: it is never a stable backend-assigned id, only the
 * sheet's own row number once a later, not-yet-built step actually
 * appends/updates a row. Paket/Depozit/Qoldiq are always '' — operator-
 * entered directly in the sheet; this function never receives (and never
 * writes) that data. placeOfBirth and the printed (visual-zone)
 * issuingAuthority are deliberately outside this input's shape, not just
 * blanked — they are not part of this schema at all.
 */
export function buildSheetRow(input: BuildSheetRowInput): string[] {
  const { ocrResult, agent } = input;
  return [
    '', // №
    fieldValue(ocrResult.firstName),
    fieldValue(ocrResult.surname),
    fieldValue(ocrResult.passportNumber),
    fieldValue(ocrResult.dateOfBirth),
    fieldValue(ocrResult.passportIssueDate),
    fieldValue(ocrResult.passportExpiryDate),
    genderLabel(ocrResult.gender),
    agent?.name ?? '',
    '', // Paket
    '', // Depozit
    '', // Qoldiq
  ];
}
