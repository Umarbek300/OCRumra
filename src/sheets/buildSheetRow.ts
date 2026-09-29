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
  /**
   * Already-formatted display strings for Paket/Depozit/Qoldiq (e.g. "$1400",
   * "1400"), or '' when nothing was reliably parsed — see
   * src/telegram/parsePackageDeposit.ts, which is the only place these
   * values are computed. Sourced from the Telegram message's own caption
   * text, NEVER from OCR/passport data (passport photos carry no
   * package/deposit information at all).
   */
  packageText: string;
  depositText: string;
  balanceText: string;
}

function fieldValue(field: OcrField): string {
  return field.value ?? '';
}

const GENDER_LABELS: Record<OcrGenderValue, string> = {
  male: 'Erkak',
  female: 'Ayol',
  unspecified: '',
};

/** Exported for reuse by buildConfirmationMessage.ts, so the Telegram confirmation and the Sheet row never disagree on gender wording. */
export function genderLabel(gender: OcrField<OcrGenderValue>): string {
  return gender.value !== null ? GENDER_LABELS[gender.value] : '';
}

/**
 * Builds one Google Sheet row from an OCR result, the agent who sent the
 * passport photo, and (separately) any package/deposit/balance text already
 * parsed from that same Telegram message's caption. Pure and side-effect
 * free — no Google API call, no DB query. Column order matches the approved
 * 12-column schema exactly: №, Ism, Familiya, Passport №, Tug'ilgan sana,
 * Berilgan sana, Amal qilish sanasi, Jins, Agent, Paket, Depozit, Qoldiq.
 *
 * № is always '' here: it is never a stable backend-assigned id, only the
 * sheet's own row number once a later, not-yet-built step actually
 * appends/updates a row. Paket/Depozit/Qoldiq come from the caller's
 * already-formatted packageText/depositText/balanceText (each '' when
 * nothing was reliably parsed) — see BuildSheetRowInput's own doc comment
 * for why this function itself never parses that text or touches OCR data
 * for it. placeOfBirth and the printed (visual-zone) issuingAuthority are
 * deliberately outside this input's shape, not just blanked — they are not
 * part of this schema at all.
 */
export function buildSheetRow(input: BuildSheetRowInput): string[] {
  const { ocrResult, agent, packageText, depositText, balanceText } = input;
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
    packageText,
    depositText,
    balanceText,
  ];
}
