export type VisaPortal = 'visitsaudi' | 'ksavisa';

export type VisaBatchStatus = 'pending' | 'submitted' | 'completed' | 'failed';

export type VisaBatchApplicantStatus = 'active' | 'cancelled' | 'removed';

export interface VisaBatch {
  id: string;
  groupId: string;
  portal: VisaPortal;
  batchNumber: number;
  batchName: string;
  status: VisaBatchStatus;
  createdAt: string;
  updatedAt: string;
}

export interface VisaBatchApplicant {
  id: string;
  batchId: string;
  groupId: string;
  passportIdentityId: string;
  portal: VisaPortal;
  positionInBatch: number;
  status: VisaBatchApplicantStatus;
  createdAt: string;
  updatedAt: string;
}

/**
 * Exactly what readVerifiedApplicantData.ts reads back from the Sheet's
 * CURRENT cell values for one applicant row -- every field is the
 * operator-verified final value, never an OCR/DB fallback. All string
 * typed because every Google Sheets cell value is a string; format
 * validity (dates, email, URLs) is validateVerifiedApplicantData.ts's job,
 * not this type's.
 */
export interface VerifiedApplicantData {
  firstName: string;
  surname: string;
  passportNumber: string;
  dateOfBirth: string;
  passportIssueDate: string;
  passportExpiryDate: string;
  gender: string;
  nationality: string;
  email: string;
  arrivalDate: string;
  personalPhotoUrl: string;
  /** Always read from the Sheet regardless of portal -- only REQUIRED for ksavisa (see validateVerifiedApplicantData.ts). May be '' for a visitsaudi-only applicant. */
  passportScanUrl: string;
}

export type ValidationFailureReason =
  | 'MISSING_FIELDS'
  | 'INVALID_DATE_OF_BIRTH'
  | 'INVALID_ISSUE_DATE'
  | 'INVALID_EXPIRY_DATE'
  | 'PASSPORT_EXPIRED'
  | 'INVALID_EMAIL'
  | 'INVALID_PHOTO_URL'
  | 'INVALID_SCAN_URL';

export type ValidationResult =
  | { ready: true }
  | { ready: false; reason: ValidationFailureReason; missingFields?: readonly string[] };

export interface VisaApplicationDraftBase {
  firstName: string;
  surname: string;
  dateOfBirth: string;
  gender: string;
  passportNumber: string;
  passportIssueDate: string;
  passportExpiryDate: string;
  nationality: string;
  email: string;
  arrivalDate: string;
  personalPhotoUrl: string;
}

export interface VisitSaudiApplicationDraft extends VisaApplicationDraftBase {
  portal: 'visitsaudi';
}

/** passportScanUrl exists ONLY on this variant -- a VisitSaudi draft structurally cannot carry one, enforced at the type level, not just by convention (see buildVisaApplicationDraft.ts's own doc comment). */
export interface KsaVisaApplicationDraft extends VisaApplicationDraftBase {
  portal: 'ksavisa';
  passportScanUrl: string;
}

export type VisaApplicationDraft = VisitSaudiApplicationDraft | KsaVisaApplicationDraft;
