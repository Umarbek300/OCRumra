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
  /** Always read from the Sheet regardless of portal -- only REQUIRED for ksavisa (see validateVerifiedApplicantData.ts). The full, uncropped applicant photo (Sheet column T) -- never used for visitsaudi, which needs the face-cropped portrait instead (see personalPortraitUrl below). */
  personalPhotoUrl: string;
  /** The face-cropped applicant portrait (Sheet column V, written by the applicant-photo-crop pipeline) -- REQUIRED for visitsaudi (the real portal only accepts a face-only portrait, never the full photo or a passport scan). Not used by ksavisa. */
  personalPortraitUrl: string;
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
  | 'INVALID_PORTRAIT_URL'
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
}

/** personalPhotoUrl structurally does not exist on this variant -- the real VisitSaudi portal only accepts a face-cropped portrait, never the full photo (see types.ts's own VerifiedApplicantData doc comment and buildVisaApplicationDraft.ts). personalPortraitUrl exists ONLY here, enforced at the type level, not just by convention. */
export interface VisitSaudiApplicationDraft extends VisaApplicationDraftBase {
  portal: 'visitsaudi';
  personalPortraitUrl: string;
}

/** personalPhotoUrl/passportScanUrl exist ONLY on this variant -- a VisitSaudi draft structurally cannot carry either, enforced at the type level, not just by convention (see buildVisaApplicationDraft.ts's own doc comment). */
export interface KsaVisaApplicationDraft extends VisaApplicationDraftBase {
  portal: 'ksavisa';
  personalPhotoUrl: string;
  passportScanUrl: string;
}

export type VisaApplicationDraft = VisitSaudiApplicationDraft | KsaVisaApplicationDraft;
