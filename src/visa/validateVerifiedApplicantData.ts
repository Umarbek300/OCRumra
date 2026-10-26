import type { ValidationResult, VerifiedApplicantData, VisaPortal } from './types.js';

const SHARED_REQUIRED_FIELDS: ReadonlyArray<[keyof VerifiedApplicantData, string]> = [
  ['firstName', 'Ism'],
  ['surname', 'Familiya'],
  ['passportNumber', 'Passport №'],
  ['dateOfBirth', "Tug'ilgan sana"],
  ['passportIssueDate', 'Berilgan sana'],
  ['passportExpiryDate', 'Amal qilish sanasi'],
  ['gender', 'Jins'],
  ['nationality', 'Fuqarolik'],
  ['email', 'Email'],
  ['arrivalDate', 'Kirish sanasi'],
];

/** The real VisitSaudi portal only accepts a face-cropped portrait -- never the full photo or a passport scan (see types.ts's own VerifiedApplicantData doc comment). */
const VISITSAUDI_ADDITIONAL_REQUIRED_FIELDS: ReadonlyArray<[keyof VerifiedApplicantData, string]> = [
  ['personalPortraitUrl', 'Portret surat URL'],
];

const KSAVISA_ADDITIONAL_REQUIRED_FIELDS: ReadonlyArray<[keyof VerifiedApplicantData, string]> = [
  ['personalPhotoUrl', 'Shaxsiy rasm URL'],
  ['passportScanUrl', 'Pasport skani URL'],
];

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE_PATTERN.test(value)) return false;
  return !Number.isNaN(Date.parse(value));
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmail(value: string): boolean {
  return EMAIL_PATTERN.test(value);
}

function isValidUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Pure (no DB, no network, no Sheets/Google API call) gate deciding whether
 * one applicant's CURRENT Sheet values are complete and well-formed enough
 * to join a visa batch. Operates ENTIRELY on the VerifiedApplicantData
 * already read live from the Sheet (see readVerifiedApplicantData.ts) --
 * never re-derives or falls back to any OCR/DB value itself.
 *
 * Required-field list differs by portal: ksavisa additionally needs
 * personalPhotoUrl (the full photo) and passportScanUrl; visitsaudi instead
 * requires personalPortraitUrl (the face-cropped portrait) -- never
 * personalPhotoUrl, and never falls back to it when personalPortraitUrl is
 * blank or invalid (VisitSaudi's own draft never carries personalPhotoUrl
 * at all -- see buildVisaApplicationDraft.ts).
 */
export function validateVerifiedApplicantData(data: VerifiedApplicantData, portal: VisaPortal): ValidationResult {
  const requiredFields =
    portal === 'ksavisa'
      ? [...SHARED_REQUIRED_FIELDS, ...KSAVISA_ADDITIONAL_REQUIRED_FIELDS]
      : [...SHARED_REQUIRED_FIELDS, ...VISITSAUDI_ADDITIONAL_REQUIRED_FIELDS];

  const missingFields = requiredFields.filter(([key]) => data[key].trim() === '').map(([, label]) => label);
  if (missingFields.length > 0) {
    return { ready: false, reason: 'MISSING_FIELDS', missingFields };
  }

  if (!isValidIsoDate(data.dateOfBirth)) {
    return { ready: false, reason: 'INVALID_DATE_OF_BIRTH' };
  }
  if (!isValidIsoDate(data.passportIssueDate)) {
    return { ready: false, reason: 'INVALID_ISSUE_DATE' };
  }
  if (!isValidIsoDate(data.passportExpiryDate)) {
    return { ready: false, reason: 'INVALID_EXPIRY_DATE' };
  }
  if (Date.parse(data.passportExpiryDate) <= Date.now()) {
    return { ready: false, reason: 'PASSPORT_EXPIRED' };
  }
  if (!isValidEmail(data.email)) {
    return { ready: false, reason: 'INVALID_EMAIL' };
  }
  if (portal === 'ksavisa') {
    if (!isValidUrl(data.personalPhotoUrl)) {
      return { ready: false, reason: 'INVALID_PHOTO_URL' };
    }
    if (!isValidUrl(data.passportScanUrl)) {
      return { ready: false, reason: 'INVALID_SCAN_URL' };
    }
  } else {
    if (!isValidUrl(data.personalPortraitUrl)) {
      return { ready: false, reason: 'INVALID_PORTRAIT_URL' };
    }
  }

  return { ready: true };
}
