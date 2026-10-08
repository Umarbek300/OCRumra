import { pool } from '../pool.js';

export type OcrConfidenceLevel = 'high' | 'medium' | 'low';
export type OcrGenderValue = 'male' | 'female' | 'unspecified';

export interface OcrField<T extends string = string> {
  value: T | null;
  confidence: OcrConfidenceLevel | null;
}

export interface CreatePassportOcrResultInput {
  telegramMessageId: string;
  /** Stable GCS object path for the applicant's personal photo (see src/visa/uploadApplicantPhoto.ts) — null when photo storage isn't configured, or the upload attempt failed. Never a public URL, never a bucket-qualified URI. */
  personalPhotoObjectPath?: string | null;
  /** Dedicated, cryptographically random public URL token (see generateApplicantPhotoToken.ts) — generated ONLY alongside a successful upload, never derived from telegram_message_id or any other existing identifier. Null whenever personalPhotoObjectPath is null. */
  personalPhotoToken?: string | null;
  /** Stable GCS object path for the applicant's CROPPED portrait — a SEPARATE artifact from personalPhotoObjectPath (the original, full, uncropped passport image). See src/visa/uploadApplicantPhoto.ts's uploadApplicantPortrait and extractApplicantPhotoCrop.ts. Null when no reliable face region was found, photo storage isn't configured, or the upload failed. */
  personalPortraitObjectPath?: string | null;
  /** Dedicated, cryptographically random public URL token for the cropped portrait — independent from personalPhotoToken, generated ONLY alongside a successful portrait upload. Null whenever personalPortraitObjectPath is null. */
  personalPortraitToken?: string | null;
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
  /** Always present (never undefined) on a record read back from the DB — null simply means no photo has been uploaded yet. */
  personalPhotoObjectPath: string | null;
  /** Always present (never undefined) on a record read back from the DB. */
  personalPhotoToken: string | null;
  /** Always present (never undefined) on a record read back from the DB — null simply means no portrait crop has been uploaded yet. */
  personalPortraitObjectPath: string | null;
  /** Always present (never undefined) on a record read back from the DB. */
  personalPortraitToken: string | null;
  createdAt: string;
  updatedAt: string;
}

interface PassportOcrResultRow {
  id: string;
  telegram_message_id: string;
  personal_photo_object_path: string | null;
  personal_photo_token: string | null;
  personal_portrait_object_path: string | null;
  personal_portrait_token: string | null;
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
    personalPhotoObjectPath: row.personal_photo_object_path,
    personalPhotoToken: row.personal_photo_token,
    personalPortraitObjectPath: row.personal_portrait_object_path,
    personalPortraitToken: row.personal_portrait_token,
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
  id, telegram_message_id, personal_photo_object_path, personal_photo_token,
  personal_portrait_object_path, personal_portrait_token,
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
       telegram_message_id, personal_photo_object_path, personal_photo_token,
       personal_portrait_object_path, personal_portrait_token,
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
       $1,$2,$3,
       $4,$5,
       $6,$7,$8,$9,
       $10,$11,$12,$13,
       $14,$15,
       $16,$17,
       $18,$19,
       $20,$21,$22,$23,
       $24,$25,
       $26,$27,$28,$29,
       $30,$31,$32,$33
     )
     ON CONFLICT (telegram_message_id) DO NOTHING
     RETURNING ${SELECT_COLUMNS}`,
    [
      input.telegramMessageId,
      input.personalPhotoObjectPath ?? null,
      input.personalPhotoToken ?? null,
      input.personalPortraitObjectPath ?? null,
      input.personalPortraitToken ?? null,
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

/**
 * The ONLY lookup the public /visa-photos/:token route is allowed to use
 * (see applicantPhotoRoute.ts) — deliberately a separate function from
 * findPassportOcrResultByTelegramMessageId above, so that route can never
 * be refactored into accidentally accepting a telegram_message_id (or any
 * other existing identifier) as the public token. Matches against
 * personal_photo_token OR personal_portrait_token — the same opaque-token
 * public route serves both the original passport image and the cropped
 * portrait, since a token's value alone can never collide between the two
 * (each is independently generated, see generateApplicantPhotoToken.ts) and
 * the partial unique index on each column already guarantees no collision
 * within a column. The caller (applicantPhotoRoute.ts) is responsible for
 * checking which of the two token fields on the returned row actually
 * equals the requested token, to pick the matching object path. A
 * telegram_message_id, passport number, or any other value passed here
 * simply won't match any row.
 */
export async function findPassportOcrResultByPersonalPhotoToken(
  token: string,
): Promise<PassportOcrResultRecord | null> {
  const { rows } = await pool.query<PassportOcrResultRow>(
    `SELECT ${SELECT_COLUMNS} FROM passport_ocr_results WHERE personal_photo_token = $1 OR personal_portrait_token = $1`,
    [token],
  );
  const row = rows[0];
  return row ? mapRow(row) : null;
}
