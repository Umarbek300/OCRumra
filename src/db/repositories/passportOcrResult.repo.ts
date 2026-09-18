import { pool } from '../pool.js';

export type OcrConfidenceLevel = 'high' | 'medium' | 'low';
export type OcrGenderValue = 'male' | 'female' | 'unspecified';

export interface OcrField<T extends string = string> {
  value: T | null;
  confidence: OcrConfidenceLevel | null;
}

export interface CreatePassportOcrResultInput {
  telegramMessageId: string;
  firstName: OcrField;
  middleName: OcrField;
  surname: OcrField;
  passportNumber: OcrField;
  dateOfBirth: OcrField;
  passportIssueDate: OcrField;
  passportExpiryDate: OcrField;
  gender: OcrField<OcrGenderValue>;
  nationality: OcrField;
  placeOfBirth: OcrField;
  issuingAuthority: OcrField;
  mrz: OcrField;
  overallConfidence: OcrConfidenceLevel;
  rawResponse: unknown;
  provider: string;
  model: string;
}

export interface PassportOcrResultRecord extends CreatePassportOcrResultInput {
  id: string;
  createdAt: string;
  updatedAt: string;
}

interface PassportOcrResultRow {
  id: string;
  telegram_message_id: string;
  first_name: string | null;
  first_name_confidence: OcrConfidenceLevel | null;
  middle_name: string | null;
  middle_name_confidence: OcrConfidenceLevel | null;
  surname: string | null;
  surname_confidence: OcrConfidenceLevel | null;
  passport_number: string | null;
  passport_number_confidence: OcrConfidenceLevel | null;
  date_of_birth: string | null;
  date_of_birth_confidence: OcrConfidenceLevel | null;
  passport_issue_date: string | null;
  passport_issue_date_confidence: OcrConfidenceLevel | null;
  passport_expiry_date: string | null;
  passport_expiry_date_confidence: OcrConfidenceLevel | null;
  gender: OcrGenderValue | null;
  gender_confidence: OcrConfidenceLevel | null;
  nationality: string | null;
  nationality_confidence: OcrConfidenceLevel | null;
  place_of_birth: string | null;
  place_of_birth_confidence: OcrConfidenceLevel | null;
  issuing_authority: string | null;
  issuing_authority_confidence: OcrConfidenceLevel | null;
  mrz: string | null;
  mrz_confidence: OcrConfidenceLevel | null;
  overall_confidence: OcrConfidenceLevel;
  raw_response: unknown;
  provider: string;
  model: string;
  created_at: string;
  updated_at: string;
}

function mapRow(row: PassportOcrResultRow): PassportOcrResultRecord {
  return {
    id: row.id,
    telegramMessageId: row.telegram_message_id,
    firstName: { value: row.first_name, confidence: row.first_name_confidence },
    middleName: { value: row.middle_name, confidence: row.middle_name_confidence },
    surname: { value: row.surname, confidence: row.surname_confidence },
    passportNumber: { value: row.passport_number, confidence: row.passport_number_confidence },
    dateOfBirth: { value: row.date_of_birth, confidence: row.date_of_birth_confidence },
    passportIssueDate: { value: row.passport_issue_date, confidence: row.passport_issue_date_confidence },
    passportExpiryDate: { value: row.passport_expiry_date, confidence: row.passport_expiry_date_confidence },
    gender: { value: row.gender, confidence: row.gender_confidence },
    nationality: { value: row.nationality, confidence: row.nationality_confidence },
    placeOfBirth: { value: row.place_of_birth, confidence: row.place_of_birth_confidence },
    issuingAuthority: { value: row.issuing_authority, confidence: row.issuing_authority_confidence },
    mrz: { value: row.mrz, confidence: row.mrz_confidence },
    overallConfidence: row.overall_confidence,
    rawResponse: row.raw_response,
    provider: row.provider,
    model: row.model,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT_COLUMNS = `
  id, telegram_message_id,
  first_name, first_name_confidence, middle_name, middle_name_confidence,
  surname, surname_confidence, passport_number, passport_number_confidence,
  date_of_birth, date_of_birth_confidence,
  passport_issue_date, passport_issue_date_confidence,
  passport_expiry_date, passport_expiry_date_confidence,
  gender, gender_confidence, nationality, nationality_confidence,
  place_of_birth, place_of_birth_confidence,
  issuing_authority, issuing_authority_confidence, mrz, mrz_confidence,
  overall_confidence, raw_response, provider, model, created_at, updated_at
`;

/**
 * Stores the OCR result for a telegram_message. Returns null (rather than
 * throwing) if one already exists — telegram_message_id is UNIQUE, so this
 * is the "never call Claude / never store twice" guarantee at the DB layer.
 */
export async function createPassportOcrResult(
  input: CreatePassportOcrResultInput,
): Promise<PassportOcrResultRecord | null> {
  const { rows } = await pool.query<PassportOcrResultRow>(
    `INSERT INTO passport_ocr_results (
       telegram_message_id,
       first_name, first_name_confidence, middle_name, middle_name_confidence,
       surname, surname_confidence, passport_number, passport_number_confidence,
       date_of_birth, date_of_birth_confidence,
       passport_issue_date, passport_issue_date_confidence,
       passport_expiry_date, passport_expiry_date_confidence,
       gender, gender_confidence, nationality, nationality_confidence,
       place_of_birth, place_of_birth_confidence,
       issuing_authority, issuing_authority_confidence, mrz, mrz_confidence,
       overall_confidence, raw_response, provider, model
     ) VALUES (
       $1,
       $2,$3,$4,$5,
       $6,$7,$8,$9,
       $10,$11,
       $12,$13,
       $14,$15,
       $16,$17,$18,$19,
       $20,$21,
       $22,$23,$24,$25,
       $26,$27,$28,$29
     )
     ON CONFLICT (telegram_message_id) DO NOTHING
     RETURNING ${SELECT_COLUMNS}`,
    [
      input.telegramMessageId,
      input.firstName.value,
      input.firstName.confidence,
      input.middleName.value,
      input.middleName.confidence,
      input.surname.value,
      input.surname.confidence,
      input.passportNumber.value,
      input.passportNumber.confidence,
      input.dateOfBirth.value,
      input.dateOfBirth.confidence,
      input.passportIssueDate.value,
      input.passportIssueDate.confidence,
      input.passportExpiryDate.value,
      input.passportExpiryDate.confidence,
      input.gender.value,
      input.gender.confidence,
      input.nationality.value,
      input.nationality.confidence,
      input.placeOfBirth.value,
      input.placeOfBirth.confidence,
      input.issuingAuthority.value,
      input.issuingAuthority.confidence,
      input.mrz.value,
      input.mrz.confidence,
      input.overallConfidence,
      JSON.stringify(input.rawResponse),
      input.provider,
      input.model,
    ],
  );
  const row = rows[0];
  return row ? mapRow(row) : null;
}

export async function findPassportOcrResultByTelegramMessageId(
  telegramMessageId: string,
): Promise<PassportOcrResultRecord | null> {
  const { rows } = await pool.query<PassportOcrResultRow>(
    `SELECT ${SELECT_COLUMNS} FROM passport_ocr_results WHERE telegram_message_id = $1`,
    [telegramMessageId],
  );
  const row = rows[0];
  return row ? mapRow(row) : null;
}
